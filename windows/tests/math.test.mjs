// TeX math in the chat (src/views/math.ts, src/views/markdown.ts): found in
// the text, drawn as readable math, never shown as raw markup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { mathText, renderMath } = await import("../src/views/math.ts");
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

test("vectors written with the notes' own macros keep their arrow", () => {
  // \vect is not LaTeX's own: it showed as "vecti" before.
  const kcl = renderMath("\\mathbf{A}\\vect{i}=\\vect{0}");
  assert.equal(kcl.textContent, "Ai=0");
  assert.equal(kcl.find(".mx-vecover").length, 2);
  assert.equal(renderMath("\\vv{F} + \\overrightarrow{AB}").find(".mx-vecover").length, 2);
  // A macro it does not know shows what it is given, not its name.
  assert.equal(mathText("\\myvector{x} + \\R"), "x+ℝ");
  assert.equal(mathText("\\color{red}{x} + \\textcolor{blue}{y}"), "x+y");
  assert.equal(mathText("\\operatorname*{argmax}_x f"), "argmaxxf");
});

test("\\left and \\right make one pair of brackets as tall as what they hold", () => {
  const a = renderMath("A=\\left( \\begin{matrix} a_{11} & a_{12} & a_{13} \\\\ a_{21} & a_{22} & a_{23} \\\\ a_{31} & a_{32} & a_{33} \\end{matrix} \\right)", true);
  assert.equal(a.textContent, "A=(a11a12a13a21a22a23a31a32a33)");
  const fences = a.find(".mx-fence");
  assert.equal(fences.length, 1);
  assert.equal(fences[0].find(".mx-delim").length, 2);
  assert.equal(fences[0].find(".mx-cell").length, 9);
  // A space before \right, a \left. with nothing, \middle, and \left\{.
  assert.equal(renderMath("\\left[ \\frac{a}{b} \\right]").find(".mx-fence").length, 1);
  assert.equal(mathText("\\left. \\frac{df}{dx} \\right|_{x=0}"), "dfdx|x=0");
  assert.equal(mathText("\\left\\{ x \\middle| x>0 \\right\\}"), "{x|x>0}");
  assert.equal(mathText("\\left\\langle u, v \\right\\rangle"), "⟨u,v⟩");
  assert.equal(mathText("\\big( x \\Big)"), "(x)");
});

test("matrices, arrays, cases and aligned rows keep their cells and columns", () => {
  const b = renderMath("\\begin{bmatrix} 1 & -1 \\\\ 0 & 1 \\end{bmatrix}");
  assert.equal(b.textContent, "[1−101]");
  assert.equal(b.find(".mx-cell").length, 4);
  assert.equal(mathText("\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}"), "|abcd|");
  assert.equal(mathText("\\begin{Bmatrix} x \\end{Bmatrix}"), "{x}");
  // A matrix inside a case, \& and braces are not this level's columns, \\[4pt] is a row.
  const cases = renderMath("f = \\begin{cases} \\begin{pmatrix} 1 & 2 \\end{pmatrix} & \\text{if } {a \\& b} \\\\[4pt] 0 & \\text{else} \\end{cases}");
  const cells = cases.find(".mx-cell").filter((c) => c.parentNode.classList.contains("mx-grid-cases"));
  assert.equal(cells.length, 4);
  assert.equal(cells[1].textContent, "if a&b");
  assert.equal(cells[0].find(".mx-cell").length, 2);
  assert.equal(cells[1].style.textAlign, "left");
  // aligned: right, then left, around the &.
  const al = renderMath("\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}", true);
  const row = al.find(".mx-cell");
  assert.equal(row.length, 4);
  assert.deepEqual(row.slice(0, 2).map((c) => c.style.textAlign), ["right", "left"]);
  assert.equal(al.textContent, "a=b+cd=e");
  // array: its column spec is not a cell, \hline is no text.
  const arr = renderMath("\\begin{array}{c|l} a & b \\\\ \\hline c & d \\end{array}");
  assert.equal(arr.textContent, "abcd");
  assert.equal(arr.find(".mx-cell")[1].style.textAlign, "left");
  assert.equal(mathText("\\binom{n}{k}"), "(nk)");
  assert.equal(mathText("\\begin{align*} x &= 1 \\end{align*}"), "x=1");
});

test("relations and operations get their room, a sign in front does not", () => {
  const f = renderMath("-a + b = c");
  assert.equal(f.textContent, "−a+b=c");
  assert.equal(f.find(".mx-rel").length, 1);
  assert.equal(f.find(".mx-bin").length, 1);
});

test("on a line of its own, sums take their limits above and below", () => {
  const display = renderMath("\\sum_{k=1}^{n} k = \\lim_{x\\to 0} f", true);
  assert.equal(display.find(".mx-limits").length, 2);
  assert.equal(display.textContent, "n∑k=1k=limx→0f");
  assert.equal(renderMath("\\sum_{k=1}^{n} k").find(".mx-limits").length, 0);
  assert.equal(renderMath("\\int_0^1 x\\,dx", true).find(".mx-int").length, 1);
  assert.equal(mathText("\\underbrace{a+b}_{n}"), "a+b⏟n");
  assert.equal(mathText("\\overset{!}{=} \\xrightarrow{f}"), "!=f⟶");
  assert.equal(mathText("\\boxed{E=mc^2} \\tag{1}"), "E=mc2  (1)");
});
