// The answer written in ink (src/views/ink.ts): where the text so far may be
// cut to be drawn, so nothing shows half-written and then changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { cutPoints, lastCut, inkWorks } = await import("../src/views/ink.ts");

/** What would be drawn of `text` with the pace at `at`. */
const drawn = (text, at = text.length, complete = false) => text.slice(0, lastCut(cutPoints(text, complete), at));

test("cuts after whole words, and the end only once the answer is complete", () => {
  assert.equal(drawn("Il test runner di No"), "Il test runner di");
  assert.equal(drawn("Il test runner di Node"), "Il test runner di");
  assert.equal(drawn("Il test runner di Node", undefined, true), "Il test runner di Node");
  assert.equal(drawn("Il test runner di Node. ", 9), "Il test");
});

test("a formula waits until it is complete", () => {
  assert.equal(drawn("Con $u = x$ e $dv = e^x"), "Con $u = x$ e");
  assert.equal(drawn("Quindi:\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{"), "Quindi:");
  assert.equal(drawn("Quindi:\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nE poi "), "Quindi:\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nE poi");
  assert.equal(drawn("Vale \\(a + b\\) e \\(c + "), "Vale \\(a + b\\) e");
  assert.equal(drawn("Vale\n\n\\[\na + b"), "Vale");
});

test("a price is not a formula, and a lone dollar lets go at the end of its line", () => {
  assert.equal(drawn("Costa $5 al mese e "), "Costa $5 al mese e");
  assert.equal(drawn("Il segno $ da solo\nE poi "), "Il segno $ da solo\nE poi");
});

test("inline code, links and bold text come whole", () => {
  assert.equal(drawn("Lancia `node --test su "), "Lancia");
  assert.equal(drawn("Lancia `node --test` su "), "Lancia `node --test` su");
  assert.equal(drawn("Vedi [la guida di Node](https://nod"), "Vedi");
  assert.equal(drawn("Un **punto molto importante** e "), "Un **punto molto importante** e");
  assert.equal(drawn("Un **punto molto "), "Un");
});

test("a list marker comes with its word, a code block flows from its first word", () => {
  assert.equal(drawn("Ecco:\n\n- "), "Ecco:");
  assert.equal(drawn("Ecco:\n\n1. Primo "), "Ecco:\n\n1. Primo");
  assert.equal(drawn("Così:\n\n```ts\nconst "), "Così:\n\n```ts\nconst");
  assert.equal(drawn("Così:\n\n```ts\n"), "Così:");
  // Inside code a dollar is only a dollar.
  assert.equal(drawn("```sh\necho $HOME e poi "), "```sh\necho $HOME e poi");
});

test("a table row comes whole", () => {
  assert.equal(drawn("Tabella:\n\n| a | b |\n| - | "), "Tabella:\n\n| a | b |");
});

test("without a real page (tests, reduced motion) the answer is drawn as it comes", () => {
  assert.equal(inkWorks(), false);
});

test("prices are cut where the chat reads them as prices (scan.ts), formulas whole", () => {
  // "25$, … 12$" is text in the chat: its words are drawn one by one.
  assert.deepEqual(cutPoints("Prezzo 25$, pranzo 12$ ok", true), [6, 11, 18, 22, 25]);
  assert.deepEqual(cutPoints("Costa $5 e $10 ok", true), [5, 8, 10, 14, 17]);
  // A formula still comes whole, and one not closed yet waits.
  assert.deepEqual(cutPoints("Sia $x_1$ ok", true), [3, 9, 12]);
  assert.equal(drawn("Sia $x_1 e"), "Sia");
});
