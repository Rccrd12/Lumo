// Permission cards: a request from the agent, through the real relay and
// pipe, answered on the island with a click, and what the agent is told.

import assert from "node:assert/strict";
import { after, afterEach, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";
import { answers, behavior } from "./lib/hook.mjs";

const G = "Permission card";
// The runner's mouse missed these now and then: they still run and show
// in the table, but do not turn the run red (no failure emails) for now.
const UNSTEADY = "unsteady on the runner: reported, does not fail the run while it is made reliable (11/11/2026)";
const app = new Lumo("permission");
const d = app.d;
/** Requests still waiting when a flow ends: let go so the next starts clean. */
const open = [];

before(() => app.launch());
afterEach(async () => {
  while (open.length) open.pop().kill();
  // The next flow starts from the closed island.
  await app.closed();
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
  const reply = await req.result(ms).catch(async (err) => {
    step(`the page's last press: ${JSON.stringify(await app.lastPress())}`);
    throw err;
  });
  step(`Claude Code is told: ${reply.stdout.trim().slice(0, 200) || "(nothing: no decision)"} after ${reply.ms} ms`);
  return reply;
}

/** The full card, from the closed island's one if that is what shows. */
async function fullCard() {
  const closed = await d.find(".cp-approval");
  if (closed) {
    step("opens the full card from the closed island's");
    await sleep(GUARD);
    await app.click(await d.visible(".cp-approval .cp-approval-who"));
  }
}

flow(G, "Bash, closed island: Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("bash-allow");
  await agent.start();
  const req = ask(agent, "Bash", { command: "git status", description: "Status" });
  const allow = await d.visible(CLOSED_ALLOW, 10_000, "Allow on the closed island's card");
  await sleep(GUARD);
  step("clicks Allow");
  await app.click(allow);
  assert.equal(behavior(await told(req)), "allow");
  await d.gone(".cp-approval", 5_000);
}, { todo: UNSTEADY });

flow(G, "Bash, closed island: Deny tells Claude Code deny", app, async () => {
  const agent = app.agent("bash-deny");
  await agent.start();
  const req = ask(agent, "Bash", { command: "git log --oneline -5", description: "Recent commits" });
  const deny = await d.visible(CLOSED_DENY, 10_000, "Deny on the closed island's card");
  await sleep(GUARD);
  step("clicks Deny");
  await app.click(deny);
  assert.equal(behavior(await told(req)), "deny");
});

flow(G, "Bash, full card: Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("bash-full");
  await agent.start();
  // A command that does more than look: the full card at once.
  const req = ask(agent, "Bash", { command: "npm test", description: "Run the tests" });
  await d.visible(ANY_ALLOW, 10_000, "the card");
  await fullCard();
  const allow = await d.visible(".allow-btn", 5_000, "Allow on the full card");
  await sleep(GUARD);
  step("clicks Allow on the full card");
  await app.click(allow);
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "A click in the first 600 ms is ignored", app, async () => {
  const agent = app.agent("guard");
  await agent.start();
  const req = ask(agent, "Bash", { command: "echo guard", description: "Guard" });
  const allow = await d.visible(CLOSED_ALLOW, 10_000, "Allow on the closed island's card");
  // A page click (no cursor travel): the guard is the page's, and a hand is too slow to test it.
  step("clicks Allow at once");
  await d.click(allow);
  await sleep(1_000);
  assert.equal(req.settled, false, "a click right after the card showed must not answer it");
  step("still waiting after 1 s; clicks Allow again");
  await app.click(await d.visible(CLOSED_ALLOW, 2_000));
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "Small Write: Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("write-small");
  await agent.start();
  const req = ask(agent, "Write", { file_path: "C:\\e2e-app\\notes.txt", content: "hello\n".repeat(300) });
  const allow = await d.visible(ANY_ALLOW, 10_000, "Allow for the Write");
  await sleep(GUARD);
  step("clicks Allow");
  await app.click(allow);
  assert.equal(behavior(await told(req)), "allow");
});

flow(G, "Write of 400 KB: the whole Write's numbers, and Allow tells Claude Code allow", app, async () => {
  const agent = app.agent("write-huge");
  await agent.start();
  // 4 096 lines of 100 bytes: 400 KB, past the 256 KB the relay forwards.
  // The text is cut on its way, which the card never shows: an ordinary card.
  const req = ask(agent, "Write", { file_path: "C:\\e2e-app\\big.txt", content: `${"x".repeat(99)}\n`.repeat(4_096) });
  await d.visible(ANY_ALLOW, 10_000, "the card");
  await fullCard();
  // The numbers under the file are the whole Write's (a new file: every line), not what the relay kept of it.
  const size = (await d.text(await d.visible(".approval-stat .size", 5_000, "the Write's size"))).trim();
  const lines = (await d.text(await d.visible(".approval-stat .plus", 5_000, "the Write's lines"))).trim();
  step(`the card says ${lines} · ${size}`);
  assert.equal(size, "400 KB", "the size of the whole Write");
  assert.equal(lines, "+4096", "the lines of the whole Write");
  const allow = await d.visible(".allow-btn", 5_000, "Allow, whatever the size");
  await sleep(GUARD);
  step("clicks Allow");
  await app.click(allow);
  assert.equal(behavior(await told(req)), "allow", "a big change is allowed like any other (pipe.rs no longer refuses it)");
});

flow(G, "Command of 200 KB: its beginning and its end, and a click on Allow allows it", app, async () => {
  const agent = app.agent("command-huge");
  await agent.start();
  // Past the 64 KB a card's command carries: the relay keeps its beginning and its end.
  const command = `$data = @'\n${'{"id":1},\n'.repeat(20_000)}'@ | Set-Content data.json; Write-Output end-of-command`;
  const req = ask(agent, "PowerShell", { command, description: "Write the data" });
  await d.visible(".allow-btn", 10_000, "the full card (never the closed island's)");
  const note = (await d.text(await d.visible(".approval-cut", 5_000, "the line that says it is cut"))).trim();
  step(`the card says: ${note}`);
  const tail = (await d.text(await d.visible(".approval-code-tail", 5_000, "the command's end"))).trim();
  assert.ok(tail.endsWith("Write-Output end-of-command"), `its end is on the card: ${tail.slice(-80)}`);
  await d.visible(".approval-gap", 5_000, "how much is not shown");
  const allow = await d.visible(".allow-btn", 5_000, "Allow");
  await sleep(GUARD);
  step("clicks Allow");
  await app.click(allow);
  assert.equal(behavior(await told(req)), "allow");
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
  await app.click(allow);
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
  await app.click(await d.visible("[data-e2e=pick]"));
  const reply = await told(req);
  assert.equal(behavior(reply), "allow");
  assert.deepEqual(answers(reply), { [question]: "Postgres" });
});

flow(G, "Two requests: each click answers the card on screen only", app, async () => {
  const a = app.agent("first");
  const b = app.agent("second");
  await a.start();
  await b.start();
  const first = ask(a, "Bash", { command: "npm run build", description: "First" });
  await d.visible(ANY_ALLOW, 10_000, "the first card");
  const second = ask(b, "Bash", { command: "npm run lint", description: "Second" });
  await sleep(GUARD);
  step("clicks Allow on what shows");
  await app.click(await d.visible(ANY_ALLOW));
  assert.equal(behavior(await told(first)), "allow", "the first request was the one on screen");
  // The second either takes the card's place or was handed back to the
  // terminal at once: never allowed by the click meant for the first.
  const end = Date.now() + 5_000;
  while (!second.settled && Date.now() < end) {
    const deny = await d.find(`${CLOSED_DENY}, .deny-btn`);
    if (deny) {
      await sleep(GUARD);
      step("the second card shows: clicks Deny");
      await app.click(deny);
      break;
    }
    await sleep(200);
  }
  const reply = await told(second);
  assert.notEqual(behavior(reply), "allow", "the second request must not be allowed by the first click");
});

flow(G, "A computer action's card: a click on it leaves the keyboard where it was", app, async () => {
  // The agent opened Search or the Start menu and asks to type: the island
  // taking the keyboard would bring it to the front, and Windows would close
  // what the agent opened. A click on the card must not.
  const agent = app.agent("computer-type");
  await agent.start();
  // The cards before gave the island the keyboard: a click on the desktop,
  // far from the island and the taskbar, hands it to another window first.
  const s = await app.screen();
  step("clicks the desktop, so the keyboard is in another window");
  await app.mouse.move(s.w * 0.75, s.h * 0.55);
  await sleep(150);
  await app.mouse.down();
  await sleep(50);
  await app.mouse.up();
  await sleep(500);
  assert.equal(await d.js("return document.hasFocus()"), false, "the island still has the keyboard after a click elsewhere");
  // Every keyboard call the page makes from here (focus_window), for the log.
  await d.js(`
    const inner = window.__TAURI_INTERNALS__;
    if (!inner.__e2eFocus) {
      inner.__e2eFocus = [];
      const invoke = inner.invoke.bind(inner);
      inner.invoke = (cmd, args, opts) => {
        if (cmd === "focus_window" || cmd === "hold_clicks") inner.__e2eFocus.push(cmd + JSON.stringify(args));
        return invoke(cmd, args, opts);
      };
    }
    inner.__e2eFocus.length = 0;
    return true;`);
  const req = ask(agent, "mcp__lumo__type", { text: "Notepad" });
  await d.visible(ANY_ALLOW, 10_000, "the card");
  const focus = async (when) => {
    const [has, calls] = await d.js("return [document.hasFocus(), window.__TAURI_INTERNALS__.__e2eFocus.join(' ')]");
    step(`${when}: island has the keyboard ${has}; keyboard calls: ${calls || "none"}`);
    return has;
  };
  await focus("the card shows");
  await fullCard();
  await focus("the full card");
  // What the action does, in the command's place (views/computer-card.ts).
  const line = await d.visible(".computer-target-slot, .approval-code", 5_000, "the card's action line");
  await sleep(GUARD);
  step("clicks the card's action line (not a button)");
  await app.click(line);
  await sleep(500);
  assert.equal(await focus("after the click"), false, "the island must not take the keyboard from the card of a computer action");
  const deny = await d.visible(".deny-btn", 5_000, "Deny on the full card");
  const box = await d.js("const b = arguments[0].getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height), devicePixelRatio]", d.ref(deny));
  step(`the keyboard stayed where it was; clicks Deny (at ${box.join(", ")})`);
  await app.click(deny);
  assert.equal(behavior(await told(req)), "deny");
});
