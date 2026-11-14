// What a question shows once sent: the bubble draws Markdown, but the stars of
// a product stay stars ("8*10^-9" is not italics).

import assert from "node:assert/strict";
import { after, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";

const G = "Chat text";
const app = new Lumo("chat-text");
const d = app.d;

before(() => app.launch());
after(() => app.close());

const QUESTION = "A me esce 8*10^-9.\nHo fatto (2.25*10^-9*0.4^3)/(2*8,99*10^9*10^-12)";

flow(G, "A question's multiplications keep their stars, with no italics", app, async () => {
  await app.open();
  await d.visible(".home-field", 8_000, "the home's Ask me anything field");
  step("opens the chat from the home's field");
  await app.click(await d.visible(".home-field"));
  const field = await d.visible(".chat-input", 5_000, "the chat's field");

  step("types the question (two lines) and sends it with the send button");
  // The field is a textarea: its value, then the input event the chat listens to.
  await d.js(
    "const f = arguments[0]; f.value = arguments[1]; f.dispatchEvent(new Event('input', { bubbles: true }));",
    d.ref(field),
    QUESTION,
  );
  await app.click(await d.visible(".send-btn", 5_000, "the send button"));

  // No provider is set up in a fresh profile: the answer fails, the question stays.
  await d.visible(".chat-row.user .bubble", 10_000, "the sent question's bubble");
  await sleep(300);
  // Read the bubble as it is now: when the answer fails the chat draws its
  // rows again, so the element found above may already have been replaced.
  const shown = await d.js(
    "const b = [...document.querySelectorAll('.chat-row.user .bubble')].pop(); return { text: b.innerText, em: b.querySelectorAll('em, strong').length };",
  );
  step(`the bubble shows ${JSON.stringify(shown.text)} (${shown.em} italic or bold parts)`);
  assert.equal(shown.em, 0, "no part of the question is italic or bold");
  for (const part of ["8*10^-9.", "(2.25*10^-9*0.4^3)/(2*8,99*10^9*10^-12)"]) {
    assert.ok(shown.text.includes(part), `the bubble shows ${part}`);
  }
});

const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long question, pasted from a log.`).join("\n");

/** The last question's bubble, the log and its Show more / Show less, as the page lays them out now. */
const LAST_FOLD = `
  const rows = [...document.querySelectorAll('.chat-row.user')];
  const bubble = rows.pop()?.querySelector('.bubble');
  const btn = bubble?.querySelector('.msg-fold');
  const log = document.querySelector('.chat-log');
  if (!bubble || !btn || !log) return null;
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
  return { bubble: r(bubble), btn: r(btn), log: r(log), shown: !btn.hidden, open: btn.getAttribute('aria-expanded') === 'true',
    fromEnd: log.scrollHeight - log.clientHeight - log.scrollTop, scrollTop: log.scrollTop };
`;

flow(G, "A long question folds; Show more opens it from where it is read, Show less stays in reach", app, async () => {
  await app.open();
  if (!(await app.onScreen(".chat-input"))) {
    step("opens the chat from the home's field");
    await app.click(await d.visible(".home-field", 8_000, "the home's Ask me anything field"));
  }
  const field = await d.visible(".chat-input", 5_000, "the chat's field");

  step("sends a question of 60 lines");
  await d.js(
    "const f = arguments[0]; f.value = arguments[1]; f.dispatchEvent(new Event('input', { bubbles: true }));",
    d.ref(field),
    LONG,
  );
  await app.click(await d.visible(".send-btn", 5_000, "the send button"));
  await d.until(`const f = (() => { ${LAST_FOLD} })(); return f && f.shown && !f.open;`, 10_000, "the question folded, with Show more");
  // The answer fails (no provider in a fresh profile) and the log is drawn again.
  await sleep(500);

  const before = await d.js(LAST_FOLD);
  step(`folded: the bubble is ${Math.round(before.bubble.bottom - before.bubble.top)} px tall, the log ${Math.round(before.fromEnd)} px from its end`);
  const folds = await d.all(".msg-fold");
  await app.click(folds[folds.length - 1]);
  await d.until(`const f = (() => { ${LAST_FOLD} })(); return f && f.open;`, 5_000, "the question open, with Show less");
  await sleep(300);
  const opened = await d.js(LAST_FOLD);
  step(`open: the bubble's top moved ${Math.round(opened.bubble.top - before.bubble.top)} px, the log is ${Math.round(opened.fromEnd)} px from its end`);
  assert.ok(Math.abs(opened.bubble.top - before.bubble.top) <= 2, "the question opens downwards: its top stays where it was read");
  assert.ok(opened.fromEnd > 100, "the log is not carried to the end of the question");

  step("scrolls into the middle of the open question");
  await d.js("const l = document.querySelector('.chat-log'); l.scrollTop = l.scrollTop + 300;");
  await sleep(300);
  const middle = await d.js(LAST_FOLD);
  assert.ok(middle.btn.bottom <= middle.log.bottom + 3 && middle.btn.top >= middle.log.top, "Show less is in sight at the log's bottom edge");
  assert.ok(middle.bubble.bottom > middle.log.bottom + 50, "the question goes on below it");
  await app.click((await d.all(".msg-fold")).pop());
  await d.until(`const f = (() => { ${LAST_FOLD} })(); return f && !f.open;`, 5_000, "the question folded again");
  await sleep(300);
  const folded = await d.js(LAST_FOLD);
  assert.ok(folded.bubble.top >= folded.log.top - 2 && folded.bubble.bottom <= folded.log.bottom + 2, "folded again, the whole question is in sight");
});
