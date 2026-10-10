// TeX math in the chat (src/views/math.ts, src/views/markdown.ts): found in
// the text, drawn as readable math, never shown as raw markup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { mathText } = await import("../src/views/math.ts");
const { parseInline, parseMarkdown } = await import("../src/views/markdown.ts");

test("formulas are found among the text, and money is not one", () => {
  const nodes = parseInline("se $\\vec{x}_0$ è un punto di **minimo** e $f:\\Omega\\to\\mathbb{R}$");
  assert.deepEqual(nodes.map((n) => n.kind), ["text", "math", "text", "strong", "text", "math"]);
  assert.equal(nodes[1].tex, "\\vec{x}_0");
  assert.deepEqual(parseInline("costa $5 e poi $10").map((n) => n.kind), ["text"]);
  assert.deepEqual(parseInline("`$x$` is code").map((n) => n.kind), ["code", "text"]);
  assert.equal(parseInline("inline \\(a+b\\) too")[1].kind, "math");
  assert.equal(parseInline("**sia $x$ reale**")[0].children[1].kind, "math");
});

test("a formula on lines of its own is a block", () => {
  const blocks = parseMarkdown("Ecco:\n$$\nH = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\nfine");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "math", "paragraph"]);
  assert.deepEqual(parseMarkdown("$$ x^2 $$").map((b) => b.kind), ["math"]);
  assert.deepEqual(parseMarkdown("\\[ \\int_0^1 f \\]").map((b) => b.kind), ["math"]);
});

test("the notation reads as math", () => {
  assert.equal(mathText("f:\\Omega\\subseteq\\mathbb{R}^n\\to\\mathbb{R}"), "f:Ω⊆ℝn→ℝ");
  assert.equal(mathText("\\nabla f(\\vec{x}_0)=\\vec{0}"), "∇f(x0)=0");
  assert.equal(mathText("\\alpha \\leq \\beta \\cdot \\gamma"), "α≤β·γ");
  assert.equal(mathText("\\frac{a}{b}"), "ab");
  assert.equal(mathText("\\sqrt{2}"), "√2");
  assert.equal(mathText("M_1, \\dots, M_n"), "M1,…,Mn");
  assert.equal(mathText("\\text{se } x>0"), "se x>0");
  assert.equal(mathText("\\sin x + \\lim_{n\\to\\infty} a_n"), "sinx+limn→∞an");
  assert.equal(mathText("Hf(\\vec{x}_0)"), "Hf(x0)");
  assert.equal(mathText("\\unknowncommand"), "unknowncommand");
  assert.equal(mathText("\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}"), "(1234)");
  assert.equal(mathText("C^2"), "C2");
});

test("the physics package's notation reads as math, not as its name", () => {
  assert.equal(mathText("\\dd W = v \\dd q"), "dW=vdq");
  assert.equal(mathText("\\dv{W}{t}"), "dWdt");
  assert.equal(mathText("\\dv{x}"), "ddx");
  assert.equal(mathText("\\dv[2]{x}{t}"), "d2xdt2");
  assert.equal(mathText("\\pdv{f}{x}"), "∂f∂x");
  assert.equal(mathText("\\abs{z}+\\norm{v}"), "|z|+‖v‖");
  assert.equal(mathText("\\braket{a}{b}"), "⟨a|b⟩");
  assert.equal(mathText("\\ket{\\psi}"), "|ψ⟩");
  assert.equal(mathText("\\grad \\phi"), "∇ϕ");
  assert.equal(mathText("\\qty(a+b)"), "(a+b)");
  assert.equal(mathText("\\int f(x) \\dd{x}"), "∫f(x)dx");
});
