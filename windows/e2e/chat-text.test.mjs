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
  const bubble = await d.visible(".chat-row.user .bubble", 10_000, "the sent question's bubble");
  await sleep(300);
  const shown = await d.js(
    "const b = arguments[0]; return { text: b.innerText, em: b.querySelectorAll('em, strong').length };",
    d.ref(bubble),
  );
  step(`the bubble shows ${JSON.stringify(shown.text)} (${shown.em} italic or bold parts)`);
  assert.equal(shown.em, 0, "no part of the question is italic or bold");
  for (const part of ["8*10^-9.", "(2.25*10^-9*0.4^3)/(2*8,99*10^9*10^-12)"]) {
    assert.ok(shown.text.includes(part), `the bubble shows ${part}`);
  }
});
