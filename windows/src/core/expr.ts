// A small arithmetic language for the chat's lumo-calc and lumo-plot cards
// (views/rich/calc.ts). A model writes formulas such as `V / R` or
// `A * sin(omega * x)`; they are read here into closures over numbers and
// never run as code: no eval, no Function, no lookup on JavaScript objects.
// The worst a wrong formula can do is give a wrong number, or NaN.
//
// What it reads:
// - numbers: 12, 1.5, .5, 1e-3 (a comma separates a function's arguments,
//   it is never a decimal point);
// - names: letters, digits and _, starting with a letter or _, and Greek
//   letters, which read as their names (ω is omega, so `ω` and `omega` are
//   the same input);
// - + - * / ^, with ^ binding tighter than a sign and to the right
//   (-2^2 is -4, 2^3^2 is 2^9), ** as ^, and × · ⋅ ÷ − ² ³ as what they mean;
// - parentheses, and calls of the functions in FUNCTIONS, their arguments
//   separated by commas; √ before a number, a name or a parenthesis;
// - a number before a name or a parenthesis multiplies it (2x, 3pi,
//   2(x + 1)), and so does a parenthesis before another ((a+b)(a-b));
//   nothing else is multiplied without a sign, so `ab` is one name;
// - the constants pi (π) and e, which an input of the same name hides.

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export interface Expr {
  /** The names the formula needs (constants left out), in the order it first uses them. */
  vars: string[];
  /** Its value for these names; throws ExprError when one it needs is missing. */
  evaluate(scope: Record<string, number>): number;
}

/** Longer is no formula a card needs. */
export const MAX_SOURCE = 1000;
/** Parentheses, signs and powers inside one another, at most. */
export const MAX_DEPTH = 100;

type Fn = (...args: number[]) => number;

/** A function, how many arguments it takes (at least, at most). */
interface FnSpec {
  fn: Fn;
  min: number;
  max: number;
}

const one = (fn: (x: number) => number): FnSpec => ({ fn, min: 1, max: 1 });

// Maps made from null, so a name such as "constructor" or "__proto__" finds
// nothing instead of a property every JavaScript object has.
const FUNCTIONS: Record<string, FnSpec> = Object.assign(Object.create(null), {
  sin: one(Math.sin),
  cos: one(Math.cos),
  tan: one(Math.tan),
  asin: one(Math.asin),
  acos: one(Math.acos),
  atan: one(Math.atan),
  atan2: { fn: Math.atan2, min: 2, max: 2 },
  sinh: one(Math.sinh),
  cosh: one(Math.cosh),
  tanh: one(Math.tanh),
  exp: one(Math.exp),
  ln: one(Math.log),
  // log(x) is base 10; log(x, b) base b, as some write it.
  log: { fn: (x: number, b?: number) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), min: 1, max: 2 },
  log2: one(Math.log2),
  sqrt: one(Math.sqrt),
  cbrt: one(Math.cbrt),
  abs: one(Math.abs),
  floor: one(Math.floor),
  ceil: one(Math.ceil),
  round: one(Math.round),
  sign: one(Math.sign),
  min: { fn: Math.min, min: 1, max: Infinity },
  max: { fn: Math.max, min: 1, max: Infinity },
  pow: { fn: Math.pow, min: 2, max: 2 },
  hypot: { fn: Math.hypot, min: 1, max: Infinity },
});

const CONSTANTS: Record<string, number> = Object.assign(Object.create(null), { pi: Math.PI, e: Math.E });

/** The Greek letters, by the names TeX gives them; µ (the micro sign) is mu too. */
export const GREEK: Record<string, string> = Object.assign(Object.create(null), {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta",
  θ: "theta", ϑ: "theta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", µ: "mu", ν: "nu", ξ: "xi",
  ο: "omicron", π: "pi", ρ: "rho", σ: "sigma", ς: "sigma", τ: "tau", υ: "upsilon", φ: "phi",
  ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
  Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Υ: "Upsilon",
  Φ: "Phi", Ψ: "Psi", Ω: "Omega",
});

/** Whether `name` is a function the formulas can call. */
export function isFunction(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}

/** Whether `name` is a constant (pi, e). */
export function isConstant(name: string): boolean {
  return Object.hasOwn(CONSTANTS, name);
}

// ── Tokens ────────────────────────────────────────────────────────────────────

type Token =
  | { t: "num"; v: number; at: number }
  | { t: "name"; v: string; at: number }
  /** + - * / ^ ( ) , and √ */
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const isDigit = (c: string) => c >= "0" && c <= "9";
const isLatin = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const NAME_REST = /[A-Za-z0-9_]/;
const SAME_AS: Record<string, string> = { "×": "*", "·": "*", "⋅": "*", "∗": "*", "÷": "/", "−": "-", "–": "-" };
const SUPERSCRIPT: Record<string, string> = { "²": "2", "³": "3" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      let j = i;
      while (isDigit(source[j] ?? "")) j++;
      if (source[j] === "." && source[j + 1] !== ".") {
        j++;
        while (isDigit(source[j] ?? "")) j++;
      }
      // An exponent only when digits follow: in 2e it is the constant e.
      const exp = /^[eE][+-]?\d+/.exec(source.slice(j));
      if (exp) j += exp[0].length;
      tokens.push({ t: "num", v: Number(source.slice(i, j)), at });
      i = j;
      continue;
    }
    if (isLatin(c) || GREEK[c]) {
      // A Greek letter goes on a name as well as starting one (Δθ, x_θ), as
      // normalizeName reads the symbol the input declared.
      let name = GREEK[c] ?? c;
      let j = i + 1;
      for (; j < source.length; j++) {
        const g = GREEK[source[j]];
        if (g) name += g;
        else if (NAME_REST.test(source[j])) name += source[j];
        else break;
      }
      tokens.push({ t: "name", v: name, at });
      i = j;
      continue;
    }
    if (SUPERSCRIPT[c]) {
      tokens.push({ t: "op", v: "^", at }, { t: "num", v: Number(SUPERSCRIPT[c]), at });
      i++;
      continue;
    }
    if (c === "*" && source[i + 1] === "*") {
      tokens.push({ t: "op", v: "^", at });
      i += 2;
      continue;
    }
    const op = SAME_AS[c] ?? c;
    if ("+-*/^(),√".includes(op)) {
      tokens.push({ t: "op", v: op, at });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected "${c}" at ${at + 1}`);
  }
  tokens.push({ t: "end", at: source.length });
  return tokens;
}

// ── Parsing, straight into closures ───────────────────────────────────────────

type Node = (scope: Record<string, number>) => number;

/** Reads `source` into a formula; throws ExprError, saying why, when it can't. */
export function compile(source: string): Expr {
  if (typeof source !== "string") throw new ExprError("Not a formula");
  if (source.length > MAX_SOURCE) throw new ExprError(`Longer than ${MAX_SOURCE} characters`);
  const tokens = tokenize(source);
  const vars: string[] = [];
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const isOp = (tok: Token, v: string): tok is Extract<Token, { t: "op" }> => tok.t === "op" && tok.v === v;
  const describe = (tok: Token) => (tok.t === "end" ? "the end" : `"${tok.t === "num" ? String(tok.v) : tok.v}" at ${tok.at + 1}`);
  const fail = (tok: Token): never => {
    throw new ExprError(`Unexpected ${describe(tok)}`);
  };
  const deeper = () => {
    if (++depth > MAX_DEPTH) throw new ExprError(`Nested more than ${MAX_DEPTH} deep`);
  };
  const expect = (v: string) => {
    const tok = peek();
    if (!isOp(tok, v)) {
      throw new ExprError(tok.t === "end" ? `Missing "${v}"` : `Expected "${v}" instead of ${describe(tok)}`);
    }
    pos++;
  };

  // sum := product (("+" | "-") product)*
  function sum(): Node {
    let left = product();
    for (;;) {
      const tok = peek();
      if (isOp(tok, "+") || isOp(tok, "-")) {
        pos++;
        const a = left;
        const b = product();
        left = tok.v === "+" ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
      } else return left;
    }
  }

  // product := signed (("*" | "/") signed | a number or ")" right before a name or "(")*
  function product(): Node {
    let left = signed();
    for (;;) {
      const tok = peek();
      const prev = tokens[pos - 1];
      const implicit =
        (prev.t === "num" && (tok.t === "name" || isOp(tok, "(") || isOp(tok, "√"))) ||
        (isOp(prev, ")") && isOp(tok, "("));
      if (isOp(tok, "*") || isOp(tok, "/") || implicit) {
        if (!implicit) pos++;
        const a = left;
        const b = signed();
        left = isOp(tok, "/") ? (s) => a(s) / b(s) : (s) => a(s) * b(s);
      } else return left;
    }
  }

  // signed := ("+" | "-") signed | power
  function signed(): Node {
    const tok = peek();
    if (isOp(tok, "-") || isOp(tok, "+")) {
      pos++;
      deeper();
      const a = signed();
      depth--;
      return tok.v === "-" ? (s) => -a(s) : a;
    }
    return power();
  }

  // power := atom ("^" signed)?, so the power reads to the right: 2^3^2 = 2^(3^2), 2^-1 = 1/2.
  function power(): Node {
    const base = atom();
    if (!isOp(peek(), "^")) return base;
    pos++;
    deeper();
    const exponent = signed();
    depth--;
    return (s) => Math.pow(base(s), exponent(s));
  }

  // atom := number | name | name "(" args ")" | "(" sum ")" | "√" atom
  function atom(): Node {
    const tok = peek();
    pos++;
    if (tok.t === "num") {
      const v = tok.v;
      return () => v;
    }
    if (tok.t === "name") {
      if (isOp(peek(), "(")) return call(tok.v);
      return variable(tok.v);
    }
    if (isOp(tok, "(")) {
      deeper();
      const inner = sum();
      expect(")");
      depth--;
      return inner;
    }
    if (isOp(tok, "√")) {
      deeper();
      const a = atom();
      depth--;
      return (s) => Math.sqrt(a(s));
    }
    return fail(tok);
  }

  function call(name: string): Node {
    if (!isFunction(name)) throw new ExprError(`Unknown function "${name}"`);
    const spec = FUNCTIONS[name];
    pos++; // "("
    deeper();
    const args: Node[] = [];
    if (!isOp(peek(), ")")) {
      args.push(sum());
      while (isOp(peek(), ",")) {
        pos++;
        args.push(sum());
      }
    }
    expect(")");
    depth--;
    if (args.length < spec.min || args.length > spec.max) {
      const wants = spec.min === spec.max ? String(spec.min) : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min} or ${spec.max}`;
      throw new ExprError(`${name}() takes ${wants} argument${wants === "1" ? "" : "s"}, not ${args.length}`);
    }
    const fn = spec.fn;
    switch (args.length) {
      case 1: {
        const [a] = args;
        return (s) => fn(a(s));
      }
      case 2: {
        const [a, b] = args;
        return (s) => fn(a(s), b(s));
      }
      default:
        return (s) => fn(...args.map((a) => a(s)));
    }
  }

  function variable(name: string): Node {
    const constant = isConstant(name) ? CONSTANTS[name] : undefined;
    if (constant === undefined && !vars.includes(name)) vars.push(name);
    return (s) => {
      if (Object.hasOwn(s, name)) return Number(s[name]);
      if (constant !== undefined) return constant;
      throw new ExprError(`No value for "${name}"`);
    };
  }

  if (peek().t === "end") throw new ExprError("Empty formula");
  const root = sum();
  if (peek().t !== "end") fail(peek());
  return { vars, evaluate: (scope) => root(scope) };
}

/**
 * A name as the formulas read it, from the ways a model may write one:
 * `ω`, `\omega`, `$V_{out}$` give omega and V_out. Null when it is no name.
 */
export function normalizeName(text: string): string | null {
  let s = text.trim().replace(/^\$+|\$+$/g, "").trim();
  s = s.replace(/^\\/, "").replace(/[{}]/g, "");
  s = [...s].map((c) => GREEK[c] ?? c).join("");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}
