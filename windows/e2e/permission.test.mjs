// Permission cards: a request from the agent, through the real relay and
// pipe, answered on the island with a click, and what the agent is told.

import assert from "node:assert/strict";
import { after, afterEach, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";
import { answers, behavior } from "./lib/hook.mjs";

const G = "Permission card";
const app = new Lumo("permission");
const d = app.d;
/** Requests still waiting when a flow ends: let go so the next starts clean. */
const open = [];

before(() => app.launch());
afterEach(async () => {
  while (open.length) open.pop().kill();
  await app.away();
  await sleep(500);
});
after(() => app.close());

/** Clicks this soon after a card shows are ignored (CLICK_GUARD_MS, 600). */
const GUARD = 800;
const CLOSED_ALLOW = ".cp-approval .cp-action.allow";
const CLOSED_DENY = ".cp-approval .cp-action:not(.allow)";
const ANY_ALLOW = `${CLOSED_ALLOW}, .allow-btn`;

function ask(agent, tool, input) {
  const req = agent.permission(tool, input);
  open.push(req);
  step(`${agent.id} asks: ${tool} ${JSON.stringify(input).slice(0, 80)}`);
  return req;
}

async function told(req, ms = 5_000) {
  const reply = await req.result(ms);
  step(`Claude Code is told: ${reply.stdout.trim().slice(0, 200) || "(nothing: no decision)"} after ${reply.ms} ms`);
  return reply;
}

/** The full card, from the closed island's one if that is what shows. */
async function fullCard() {
  const closed = await d.find(".cp-approval");
  if (closed) {
    step("opens the full card from the closed island's");
    await sleep(GUARD);
    await d.click(await d.visible(".cp-approval .cp-approval-who"));
  }
}

flow(G, "Bash, closed island: Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("bash-allow");
  await agent.start();
  const req = ask(agent, "Bash", { command: "npm test", description: "Run the tests" });
  const allow = await d.visible(CLOSED_ALLOW, 10_000, "Allow on the closed island's card");
  await sleep(GUARD);
  step("clicks Allow");
  await d.click(allow);
  assert.equal(behavior(await told(req)), "allow");
  await d.gone(".cp-approval", 5_000);
});

flow(G, "Bash, closed island: Deny tells Claude Code deny", app, async () => {
  const agent = app.agent("bash-deny");
  await agent.start();
  const req = ask(agent, "Bash", { command: "rm -rf build", description: "Clean" });
  const deny = await d.visible(CLOSED_DENY, 10_000, "Deny on the closed island's card");
  await sleep(GUARD);
  step("clicks Deny");
  await d.click(deny);
  assert.equal(behavior(await told(req)), "deny");
});

flow(G, "Bash, full card: Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("bash-full");
  await agent.start();
  const req = ask(agent, "Bash", { command: "git status", description: "Status" });
  await d.visible(ANY_ALLOW, 10_000, "the card");
  await fullCard();
  const allow = await d.visible(".allow-btn", 5_000, "Allow on the full card");
  await sleep(GUARD);
  step("clicks Allow on the full card");
  await d.click(allow);
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "A click in the first 600 ms is ignored", app, async () => {
  const agent = app.agent("guard");
  await agent.start();
  const req = ask(agent, "Bash", { command: "echo guard", description: "Guard" });
  const allow = await d.visible(CLOSED_ALLOW, 10_000, "Allow on the closed island's card");
  step("clicks Allow at once");
  await d.click(allow);
  await sleep(1_000);
  assert.equal(req.settled, false, "a click right after the card showed must not answer it");
  step("still waiting after 1 s; clicks Allow again");
  await d.click(await d.visible(CLOSED_ALLOW, 2_000));
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "Small Write: Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("write-small");
  await agent.start();
  const req = ask(agent, "Write", { file_path: "C:\\e2e-app\\notes.txt", content: "hello\n".repeat(300) });
  const allow = await d.visible(ANY_ALLOW, 10_000, "Allow for the Write");
  await sleep(GUARD);
  step("clicks Allow");
  await d.click(allow);
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "Write of 400 KB: no Allow, only Deny", app, async () => {
  const agent = app.agent("write-huge");
  await agent.start();
  const req = ask(agent, "Write", { file_path: "C:\\e2e-app\\big.txt", content: "x".repeat(400 * 1024) });
  await d.visible(".approval-cut, .cp-approval", 10_000, "the card");
  await fullCard();
  await d.visible(".approval-cut", 5_000, "the note that the request is too long to allow");
  assert.equal(await d.find(".allow-btn"), null, "Allow must not be offered for a request not shown whole");
  assert.equal(await d.find(CLOSED_ALLOW), null, "nor on the closed island");
  const deny = await d.visible(".deny-btn", 5_000, "Deny");
  await sleep(GUARD);
  step("clicks Deny");
  await d.click(deny);
  assert.equal(behavior(await told(req)), "deny");
});

flow(G, "Long plan: the card fits on screen and Allow works", app, async () => {
  const agent = app.agent("plan");
  await agent.start();
  const plan = ["# Plan", "", ...Array.from({ length: 120 }, (_, i) => `${i + 1}. Step ${i + 1}: change module ${i + 1} and test it.`)].join("\n");
  const req = ask(agent, "ExitPlanMode", { plan });
  await d.visible(ANY_ALLOW, 10_000, "the plan's card");
  await fullCard();
  const allow = await d.visible(".allow-btn", 5_000, "Allow on the plan's card");
  const fits = await d.js(`
    const b = [...document.querySelectorAll('.allow-btn')].find((e) => e.offsetParent).getBoundingClientRect();
    const i = document.getElementById('island').getBoundingClientRect();
    return { button: [b.top, b.bottom], island: [i.top, i.bottom], window: innerHeight };`);
  step(`button ${JSON.stringify(fits.button)}, island ${JSON.stringify(fits.island)}, window ${fits.window}`);
  assert.ok(fits.button[1] <= fits.island[1] + 1 && fits.island[1] <= fits.window + 1, "Allow must be inside the island, and the island inside its window");
  await sleep(GUARD);
  step("clicks Allow");
  await d.click(allow);
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "A question: the option picked goes back to Claude Code", app, async () => {
  const agent = app.agent("question");
  await agent.start();
  const question = "Which database should the app use?";
  const req = ask(agent, "AskUserQuestion", {
    questions: [{
      question,
      header: "Database",
      multiSelect: false,
      options: [
        { label: "SQLite", description: "A file, nothing to install" },
        { label: "Postgres", description: "A server" },
      ],
    }],
  });
  await d.visible(".q-option, .cp-approval", 10_000, "the question");
  await fullCard();
  await d.visible(".q-option", 5_000, "the options");
  await sleep(GUARD);
  const picked = await d.js(`
    const b = [...document.querySelectorAll('.q-option')].find((e) => e.offsetParent && e.textContent.startsWith('Postgres'));
    if (b) b.dataset.e2e = 'pick';
    return !!b;`);
  assert.ok(picked, "the option Postgres is on the card");
  step("clicks Postgres");
  await d.click(await d.visible("[data-e2e=pick]"));
  const reply = await told(req);
  assert.equal(behavior(reply), "allow");
  assert.deepEqual(answers(reply), { [question]: "Postgres" });
});

flow(G, "Two requests: each click answers the card on screen only", app, async () => {
  const a = app.agent("first");
  const b = app.agent("second");
  await a.start();
  await b.start();
  const first = ask(a, "Bash", { command: "echo first", description: "First" });
  await d.visible(ANY_ALLOW, 10_000, "the first card");
  const second = ask(b, "Bash", { command: "echo second", description: "Second" });
  await sleep(GUARD);
  step("clicks Allow on what shows");
  await d.click(await d.visible(ANY_ALLOW));
  assert.equal(behavior(await told(first)), "allow", "the first request was the one on screen");
  // The second either takes the card's place or was handed back to the
  // terminal at once: never allowed by the click meant for the first.
  const end = Date.now() + 5_000;
  while (!second.settled && Date.now() < end) {
    const deny = await d.find(`${CLOSED_DENY}, .deny-btn`);
    if (deny) {
      await sleep(GUARD);
      step("the second card shows: clicks Deny");
      await d.click(deny);
      break;
    }
    await sleep(200);
  }
  const reply = await told(second);
  assert.notEqual(behavior(reply), "allow", "the second request must not be allowed by the first click");
});
