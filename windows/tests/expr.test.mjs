// The formulas of the lumo-calc and lumo-plot cards (src/core/expr.ts): read
// into closures, never run as code. Precedence, the multiplications written
// without a sign, the Unicode a model writes, and the names that must never
// reach a JavaScript object's properties.

import { test } from "node:test";
import assert from "node:assert/strict";

const { compile, ExprError, normalizeName, fromTeX, MAX_DEPTH } = await import("../src/core/expr.ts");

const run = (source, scope = {}) => compile(source).evaluate(scope);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≉ ${b}`);
const throwsExpr = (source, pattern) =>
  assert.throws(() => compile(source), (err) => err instanceof ExprError && (!pattern || pattern.test(err.message)), source);

test("numbers in their usual forms", () => {
  assert.equal(run("123"), 123);
  assert.equal(run("1.5"), 1.5);
  assert.equal(run(".5"), 0.5);
  assert.equal(run("1e-3"), 0.001);
  assert.equal(run("2.5E2"), 250);
  assert.equal(run("  7  "), 7);
});

test("precedence and associativity", () => {
  assert.equal(run("1 + 2 * 3"), 7);
  assert.equal(run("(1 + 2) * 3"), 9);
  assert.equal(run("10 - 4 - 3"), 3);
  assert.equal(run("24 / 4 / 3"), 2);
  assert.equal(run("2 ^ 3 ^ 2"), 512);
  assert.equal(run("-2 ^ 2"), -4);
  assert.equal(run("(-2) ^ 2"), 4);
  assert.equal(run("2 ^ -1"), 0.5);
  assert.equal(run("--3"), 3);
  assert.equal(run("+3 - -2"), 5);
  assert.equal(run("2 * -3"), -6);
  assert.equal(run("2 ** 3"), 8);
});

test("a number before a name or a parenthesis multiplies it, and so does ) before (", () => {
  assert.equal(run("2x", { x: 5 }), 10);
  assert.equal(run("2(x + 1)", { x: 5 }), 12);
  assert.equal(run("2 (x + 1)", { x: 5 }), 12);
  close(run("3pi"), 3 * Math.PI);
  assert.equal(run("(a + b)(a - b)", { a: 5, b: 3 }), 16);
  assert.equal(run("2x^2", { x: 3 }), 18);
  assert.equal(run("-2x", { x: 3 }), -6);
  assert.equal(run("1/2x", { x: 4 }), 2, "left to right, as written");
  close(run("2sin(x)", { x: 1 }), 2 * Math.sin(1));
  close(run("2e"), 2 * Math.E);
  // Nothing else: two names side by side are one name, two numbers an error.
  assert.deepEqual(compile("ab").vars, ["ab"]);
  throwsExpr("2 3", /Unexpected "3"/);
  throwsExpr("(x)y", /Unexpected "y"/);
});

test("the Unicode a model writes", () => {
  assert.equal(run("3 × 4"), 12);
  assert.equal(run("3 · 4"), 12);
  assert.equal(run("3 ⋅ 4"), 12);
  assert.equal(run("12 ÷ 4"), 3);
  assert.equal(run("5 − 2"), 3);
  assert.equal(run("x²", { x: 3 }), 9);
  assert.equal(run("x³ + 1", { x: 2 }), 9);
  assert.equal(run("√16"), 4);
  assert.equal(run("√(x + 7)", { x: 9 }), 4);
  close(run("2π"), 2 * Math.PI);
  const omega = compile("A·sin(ω×t)");
  assert.deepEqual(omega.vars, ["A", "omega", "t"]);
  close(omega.evaluate({ A: 2, omega: 3, t: 0.5 }), 2 * Math.sin(1.5));
  assert.deepEqual(compile("Δx + µ0 + ω_0").vars, ["Deltax", "mu0", "omega_0"]);
  // A Greek letter inside a name stays in it, as normalizeName reads the input's symbol.
  assert.deepEqual(compile("r * Δθ + x_θ").vars, ["r", "Deltatheta", "x_theta"]);
  assert.equal(normalizeName("Δθ"), "Deltatheta");
  assert.equal(normalizeName("x_θ"), "x_theta");
  assert.deepEqual(compile("ωt").vars, [normalizeName("ωt")]);
});

test("primes as a formula writes them: y″, x^{\\prime}", () => {
  assert.equal(normalizeName("y″"), "y''");
  assert.deepEqual(compile("y″ + y‴").vars, ["y''", "y'''"]);
  assert.deepEqual(compile(fromTeX("2 x^{\\prime} + x^\\prime + y^{\\prime\\prime}")).vars, ["x'", "y''"]);
  assert.deepEqual(compile(fromTeX("\\frac{x^{\\prime}}{2}")).vars, ["x'"]);
});

test("names ending with primes", () => {
  assert.equal(normalizeName("x'"), "x'");
  assert.equal(normalizeName("$y''$"), "y''");
  assert.equal(normalizeName("x′"), "x'");
  assert.equal(normalizeName("x’"), "x'");
  assert.equal(normalizeName("x^{\\prime}"), "x'");
  assert.equal(normalizeName("x^{\\prime\\prime}"), "x''");
  assert.equal(normalizeName("x'y"), null);
  assert.equal(normalizeName("'x"), null);
  assert.deepEqual(compile("x' + 2*x'' - x′").vars.sort(), ["x'", "x''"]);
  assert.equal(run("x' * x''", { "x'": 3, "x''": 4 }), 12);
});

test("functions and their arguments", () => {
  close(run("sin(pi / 2)"), 1);
  close(run("cos(0) + tan(0)"), 1);
  close(run("atan2(1, 1)"), Math.PI / 4);
  close(run("asin(1) + acos(1) + atan(0)"), Math.PI / 2);
  close(run("sinh(0) + cosh(0) + tanh(0)"), 1);
  close(run("exp(1)"), Math.E);
  close(run("ln(e)"), 1);
  close(run("log(1000)"), 3);
  close(run("log(8, 2)"), 3);
  assert.equal(run("log2(8)"), 3);
  assert.equal(run("sqrt(9) + cbrt(27)"), 6);
  assert.equal(run("abs(-3) + floor(1.7) + ceil(1.2) + round(2.5) + sign(-4)"), 3 + 1 + 2 + 3 - 1);
  assert.equal(run("min(3, 1, 2) + max(4, 9)"), 10);
  assert.equal(run("pow(2, 10)"), 1024);
  assert.equal(run("hypot(3, 4)"), 5);
  assert.equal(run("max(1, 2, 3, 4)"), 4);
  throwsExpr("sin()", /sin\(\) takes 1 argument, not 0/);
  throwsExpr("sin(1, 2)", /takes 1 argument/);
  throwsExpr("atan2(1)", /takes 2 arguments/);
  throwsExpr("max()", /at least 1/);
  throwsExpr("foo(1)", /Unknown function "foo"/);
  throwsExpr("x(2)", /Unknown function "x"/);
});

test("constants, which a value of the same name hides", () => {
  close(run("pi"), Math.PI);
  close(run("e"), Math.E);
  assert.deepEqual(compile("2pi*r + e").vars, ["r"]);
  assert.equal(run("e * 2", { e: 5 }), 10);
  assert.equal(run("pi", { pi: 3 }), 3);
});

test("the names it needs, in the order it first uses them", () => {
  assert.deepEqual(compile("b * a + b / c").vars, ["b", "a", "c"]);
  assert.deepEqual(compile("4").vars, []);
  assert.deepEqual(compile("sin(x)").vars, ["x"]);
});

test("a missing value throws when the formula is evaluated", () => {
  const f = compile("V / R");
  assert.equal(f.evaluate({ V: 12, R: 4 }), 3);
  assert.throws(() => f.evaluate({ V: 12 }), (err) => err instanceof ExprError && /No value for "R"/.test(err.message));
});

test("JavaScript's own names are only names, never an object's properties", () => {
  for (const name of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "prototype", "globalThis", "process"]) {
    const f = compile(`${name} + 1`);
    assert.deepEqual(f.vars, [name]);
    assert.throws(() => f.evaluate({}), ExprError, name);
    assert.equal(f.evaluate({ [name]: 2 }), 3);
    throwsExpr(`${name}(1)`, /Unknown function/);
  }
  // Inherited properties of the scope are not its values.
  const scope = Object.create({ inherited: 4 });
  assert.throws(() => compile("inherited").evaluate(scope), ExprError);
  // What would be code is not a formula.
  throwsExpr("x.constructor");
  throwsExpr("a[0]");
  throwsExpr("alert('hi')");
  throwsExpr("x = 2");
  throwsExpr("`x`");
  throwsExpr("a; b");
});

test("what can't be read says why", () => {
  throwsExpr("", /Empty/);
  throwsExpr("   ", /Empty/);
  throwsExpr("1 +", /Unexpected the end/);
  throwsExpr("(1 + 2", /Missing "\)"/);
  throwsExpr("1 + 2)", /Unexpected "\)"/);
  throwsExpr("* 2", /Unexpected "\*"/);
  throwsExpr("2 # 3", /Unexpected "#" at 3/);
  throwsExpr("1,5", /Unexpected ","/);
  throwsExpr("x".repeat(1001), /Longer than 1000/);
  assert.equal(compile("1+".repeat(499) + "1").evaluate({}), 500);
});

test("nesting stops at its limit, well before the stack does", () => {
  const nested = (n) => "(".repeat(n) + "1" + ")".repeat(n);
  assert.equal(run(nested(MAX_DEPTH)), 1);
  throwsExpr(nested(MAX_DEPTH + 1), /Nested more than/);
  throwsExpr("-".repeat(MAX_DEPTH + 1) + "1", /Nested more than/);
  throwsExpr("2^".repeat(MAX_DEPTH + 1) + "1", /Nested more than/);
  throwsExpr("sin(".repeat(MAX_DEPTH + 1) + "1" + ")".repeat(MAX_DEPTH + 1), /Nested more than/);
  assert.equal(run("-".repeat(MAX_DEPTH) + "1"), 1);
});

test("NaN and infinities are values, not errors", () => {
  assert.equal(run("1 / 0"), Infinity);
  assert.ok(Number.isNaN(run("sqrt(-1)")));
  assert.ok(Number.isNaN(run("0 / 0")));
});

test("it is quick enough to draw a chart", () => {
  const f = compile("A * sin(omega * x) + 0.5 x^2 - ln(abs(x) + 1)");
  const scope = { A: 1, omega: 2, x: 0 };
  let sum = 0;
  for (let i = 0; i < 6000; i++) {
    scope.x = i / 100;
    sum += f.evaluate(scope);
  }
  assert.ok(Number.isFinite(sum));
});

test("names as models write them", () => {
  assert.equal(normalizeName("ω"), "omega");
  assert.equal(normalizeName("\\omega"), "omega");
  assert.equal(normalizeName("$V_{out}$"), "V_out");
  assert.equal(normalizeName(" R "), "R");
  assert.equal(normalizeName("2x"), null);
  assert.equal(normalizeName("a b"), null);
  assert.equal(normalizeName(""), null);
});
