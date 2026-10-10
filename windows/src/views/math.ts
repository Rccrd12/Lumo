// TeX math in the chat's answers ($…$, $$…$$, \(…\), \[…\]), drawn as DOM
// with no library: the notation answers use — Greek letters, operators and
// arrows, sub- and superscripts, \frac, \sqrt, \vec and other accents,
// \mathbb and friends, \text, \left…\right, matrices, cases and aligned
// rows, and the physics package's \dd, \dv, \pdv, \abs, \norm and bra-kets.
// What it does not know shows as its name, never as raw markup.
//
// Built with textContent only, like the rest of the Markdown (markdown.ts).

import { h } from "./dom";

const SYMBOLS: Record<string, string> = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Operators and relations
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃",
  cong: "≅", equiv: "≡", propto: "∝", ll: "≪", gg: "≫", prec: "≺", succ: "≻",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃",
  nexists: "∄", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨", oplus: "⊕",
  otimes: "⊗", perp: "⊥", parallel: "∥", mid: "∣", nmid: "∤", top: "⊤", bot: "⊥",
  // Calculus and the rest
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬",
  iiint: "∭", oint: "∮", sqrt: "√", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", angle: "∠",
  degree: "°", prime: "′", dagger: "†", triangle: "△", square: "□", checkmark: "✓",
  // Arrows
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺", mapsto: "↦",
  longrightarrow: "⟶", longleftarrow: "⟵", uparrow: "↑", downarrow: "↓", nearrow: "↗", searrow: "↘",
  hookrightarrow: "↪", rightharpoonup: "⇀",
  // Dots, brackets, spaces
  dots: "…", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", langle: "⟨", rangle: "⟩",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}", vert: "|", Vert: "‖",
  "|": "‖", "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", _: "_",
  quad: " ", qquad: "  ", ",": " ", ":": " ", ";": " ", "!": "", " ": " ",
};

/** Functions set upright: \sin x, \lim, \max… */
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det", "dim",
  "ker", "deg", "gcd", "arg", "Pr", "mod", "rank", "tr", "sgn",
]);

/** Combining marks for the accents. */
const ACCENTS: Record<string, string> = {
  vec: "⃗", hat: "̂", widehat: "̂", tilde: "̃", widetilde: "̃",
  dot: "̇", ddot: "̈", acute: "́", grave: "̀", check: "̌", breve: "̆",
};

/** \mathbb letters (double-struck). */
const DOUBLE: Record<string, string> = {
  C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ",
};

function doubleStruck(c: string): string {
  if (DOUBLE[c]) return DOUBLE[c];
  if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d538 + c.charCodeAt(0) - 65);
  if (/[a-z]/.test(c)) return String.fromCodePoint(0x1d552 + c.charCodeAt(0) - 97);
  if (/[0-9]/.test(c)) return String.fromCodePoint(0x1d7d8 + c.charCodeAt(0) - 48);
  return c;
}

function script(c: string): string {
  const special: Record<string, string> = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
  if (special[c]) return special[c];
  if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d49c + c.charCodeAt(0) - 65);
  return c;
}

function fraktur(c: string): string {
  const special: Record<string, string> = { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" };
  if (special[c]) return special[c];
  if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d504 + c.charCodeAt(0) - 65);
  if (/[a-z]/.test(c)) return String.fromCodePoint(0x1d51e + c.charCodeAt(0) - 97);
  return c;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

type Node =
  | { t: "sym"; v: string; upright?: boolean }
  | { t: "group"; c: Node[] }
  | { t: "sup"; base: Node | null; sup: Node | null; sub: Node | null }
  | { t: "frac"; num: Node; den: Node }
  | { t: "sqrt"; body: Node; index: Node | null }
  | { t: "accent"; mark: string; body: Node }
  | { t: "over"; body: Node; under?: boolean }
  | { t: "style"; style: "bold" | "upright" | "text"; body: Node }
  | { t: "matrix"; rows: Node[][]; open: string; close: string }
  | { t: "op"; name: string };

class Parser {
  private i = 0;
  private s: string;
  constructor(s: string) {
    this.s = s;
  }

  parse(stop?: (s: string, i: number) => boolean): Node[] {
    const out: Node[] = [];
    while (this.i < this.s.length) {
      if (stop?.(this.s, this.i)) break;
      const c = this.s[this.i];
      if (c === "}") break;
      if (c === "^" || c === "_") {
        this.i++;
        const arg = this.atom();
        const last = out.pop() ?? null;
        const node = last && last.t === "sup" && (c === "^" ? !last.sup : !last.sub) ? last : { t: "sup" as const, base: last, sup: null, sub: null };
        if (c === "^") node.sup = arg;
        else node.sub = arg;
        out.push(node);
        continue;
      }
      const atom = this.atom();
      if (atom) out.push(atom);
    }
    return out;
  }

  private group(): Node {
    // At "{": up to its "}".
    this.i++;
    const c = this.parse();
    if (this.s[this.i] === "}") this.i++;
    return { t: "group", c };
  }

  /** One argument: a group, a command, or one character. */
  private atom(): Node | null {
    const s = this.s;
    while (s[this.i] === " ") this.i++;
    if (this.i >= s.length) return null;
    const c = s[this.i];
    if (c === "{") return this.group();
    if (c === "\\") return this.command();
    if (c === "'") {
      this.i++;
      return { t: "sym", v: "′", upright: true };
    }
    this.i++;
    if (c === "~") return { t: "sym", v: " ", upright: true };
    return { t: "sym", v: c, upright: !/[A-Za-z]/.test(c) };
  }

  private name(): string {
    const s = this.s;
    this.i++; // the backslash
    const m = /^[A-Za-z]+/.exec(s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return m[0];
    }
    return s[this.i++] ?? "";
  }

  private command(): Node | null {
    const name = this.name();
    const arg = () => this.atom() ?? { t: "group" as const, c: [] };
    switch (name) {
      case "frac": case "dfrac": case "tfrac": case "cfrac":
        return { t: "frac", num: arg(), den: arg() };
      case "binom": {
        const top = arg();
        const bottom = arg();
        return { t: "matrix", rows: [[top], [bottom]], open: "(", close: ")" };
      }
      case "sqrt": {
        let index: Node | null = null;
        if (this.s[this.i] === "[") {
          const end = this.s.indexOf("]", this.i);
          if (end > 0) {
            index = { t: "group", c: new Parser(this.s.slice(this.i + 1, end)).parse() };
            this.i = end + 1;
          }
        }
        return { t: "sqrt", body: arg(), index };
      }
      case "overline": case "bar": return { t: "over", body: arg() };
      case "underline": return { t: "over", body: arg(), under: true };
      case "mathbb": case "Bbb": return this.mapped(arg(), doubleStruck);
      case "mathcal": case "mathscr": return this.mapped(arg(), script);
      case "mathfrak": return this.mapped(arg(), fraktur);
      case "mathbf": case "boldsymbol": case "bm": case "bf": return { t: "style", style: "bold", body: arg() };
      case "mathrm": case "operatorname": case "mathsf": case "mathtt": case "rm":
        return { t: "style", style: "upright", body: arg() };
      case "text": case "textrm": case "textbf": case "textit": case "mbox": case "textnormal":
        return this.text();
      case "left": case "right": case "big": case "Big": case "bigg": case "Bigg":
      case "bigl": case "bigr": case "Bigl": case "Bigr": {
        // The delimiter that follows, as is ("." is none).
        const d = this.atom();
        if (d && d.t === "sym" && d.v === ".") return null;
        return d;
      }
      case "begin": return this.environment();
      case "end": {
        arg();
        return null;
      }
      case "displaystyle": case "textstyle": case "limits": case "nolimits": case "notag": case "nonumber":
        return null;
      // The physics package's notation, which answers copy from LaTeX sources:
      // \dd x, \dv{f}{x}, \pdv{f}{x}, \abs{x}, \norm{v}, \vb{F}, bra-kets…
      case "dd": case "differential": {
        const order = this.optional();
        const d: Node = order ? { t: "sup", base: { t: "sym", v: "d", upright: true }, sup: order, sub: null } : { t: "sym", v: "d", upright: true };
        return this.s[this.i] === "{" ? { t: "group", c: [d, arg()] } : d;
      }
      case "dv": case "derivative": return this.derivative("d");
      case "pdv": case "partialderivative": return this.derivative("∂");
      case "abs": case "absolutevalue": return this.fenced("|", arg(), "|");
      case "norm": return this.fenced("‖", arg(), "‖");
      case "ev": case "expval": case "expectationvalue": return this.fenced("⟨", arg(), "⟩");
      case "bra": return this.fenced("⟨", arg(), "|");
      case "ket": return this.fenced("|", arg(), "⟩");
      case "braket": {
        const a = arg();
        const b = this.s[this.i] === "{" ? arg() : a;
        return this.fenced("⟨", { t: "group", c: [a, { t: "sym", v: "|", upright: true }, b] }, "⟩");
      }
      case "vb": case "vectorbold": return { t: "style", style: "bold", body: arg() };
      case "vu": case "vectorunit": return { t: "style", style: "bold", body: { t: "accent", mark: ACCENTS.hat, body: arg() } };
      case "grad": case "gradient": return { t: "sym", v: "∇", upright: true };
      case "curl": return { t: "sym", v: "∇×", upright: true };
      case "divergence": return { t: "sym", v: "∇·", upright: true };
      case "order": return { t: "group", c: [{ t: "sym", v: "O", upright: false }, this.fenced("(", arg(), ")")] };
      case "qty": case "quantity":
        // \qty(x), \qty[x]: the brackets that follow are drawn as they are.
        return this.s[this.i] === "{" ? this.fenced("{", arg(), "}") : null;
      case "not": {
        const next = this.atom();
        if (next && next.t === "sym") return { t: "sym", v: `${next.v}̸`, upright: true };
        return next;
      }
    }
    if (ACCENTS[name]) return { t: "accent", mark: ACCENTS[name], body: arg() };
    if (FUNCTIONS.has(name)) return { t: "op", name };
    if (name in SYMBOLS) return { t: "sym", v: SYMBOLS[name], upright: true };
    // Unknown: its name, upright, rather than the markup.
    return { t: "sym", v: name, upright: true };
  }

  /** `[…]` right here, if there is one: \dd[3]{x}, \dv[2]{f}{x}. */
  private optional(): Node | null {
    if (this.s[this.i] !== "[") return null;
    const end = this.s.indexOf("]", this.i);
    if (end < 0) return null;
    const inside = new Parser(this.s.slice(this.i + 1, end)).parse();
    this.i = end + 1;
    return { t: "group", c: inside };
  }

  /** `open` body `close`, upright. */
  private fenced(open: string, body: Node, close: string): Node {
    return { t: "group", c: [{ t: "sym", v: open, upright: true }, body, { t: "sym", v: close, upright: true }] };
  }

  /** \dv{f}{x} as df/dx, \dv{x} as d/dx, \dv[2]{f}{x} as d²f/dx²; `d` is "d" or "∂". */
  private derivative(d: string): Node {
    const order = this.optional();
    const mark = (): Node => (order ? { t: "sup", base: { t: "sym", v: d, upright: true }, sup: order, sub: null } : { t: "sym", v: d, upright: true });
    const first = this.atom() ?? { t: "group" as const, c: [] };
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] !== "{") {
      // Only the variable: the operator d/dx.
      const by: Node = order ? { t: "sup", base: first, sup: order, sub: null } : first;
      return { t: "frac", num: mark(), den: { t: "group", c: [{ t: "sym", v: d, upright: true }, by] } };
    }
    const by = this.atom() ?? { t: "group" as const, c: [] };
    const den: Node = { t: "group", c: [{ t: "sym", v: d, upright: true }, order ? { t: "sup", base: by, sup: order, sub: null } : by] };
    return { t: "frac", num: { t: "group", c: [mark(), first] }, den };
  }

  /** \text{…}: what is inside, as words. */
  private text(): Node {
    if (this.s[this.i] !== "{") return { t: "group", c: [] };
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "{") depth++;
      else if (this.s[this.i] === "}" && --depth === 0) break;
    }
    const words = this.s.slice(start, this.i).replace(/\\([{}$%&#_ ])/g, "$1");
    this.i++;
    return { t: "style", style: "text", body: { t: "sym", v: words, upright: true } };
  }

  private mapped(node: Node, f: (c: string) => string): Node {
    const flat = flatten(node);
    return { t: "sym", v: [...flat].map(f).join(""), upright: true };
  }

  /** \begin{pmatrix} a & b \\ c & d \end{pmatrix}, cases, aligned… */
  private environment(): Node {
    const arg = this.atom();
    const env = arg ? flatten(arg) : "";
    const end = `\\end{${env}}`;
    const close = this.s.indexOf(end, this.i);
    const body = this.s.slice(this.i, close < 0 ? undefined : close);
    this.i = close < 0 ? this.s.length : close + end.length;
    const rows = body
      .split(/\\\\/)
      .map((r) => r.trim())
      .filter((r, k, all) => r !== "" || k < all.length - 1)
      .map((r) => r.split("&").map((cell) => ({ t: "group" as const, c: new Parser(cell.trim()).parse() })));
    const brackets: Record<string, [string, string]> = {
      pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"],
      Vmatrix: ["‖", "‖"], cases: ["{", ""], dcases: ["{", ""],
    };
    const [open, closeMark] = brackets[env] ?? ["", ""];
    return { t: "matrix", rows, open, close: closeMark };
  }
}

/** The plain characters of a node, for \mathbb{R} and the like. */
function flatten(node: Node): string {
  switch (node.t) {
    case "sym": return node.v;
    case "group": return node.c.map(flatten).join("");
    case "style": return flatten(node.body);
    default: return "";
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function draw(node: Node): HTMLElement | Text {
  switch (node.t) {
    case "sym":
      return node.upright || node.v.length !== 1 ? document.createTextNode(node.v) : h("i", { class: "mx-var", text: node.v });
    case "op":
      return h("span", { class: "mx-op", text: node.name });
    case "group":
      return drawAll(node.c, "span");
    case "sup": {
      const el = h("span", { class: "mx-script" });
      if (node.base) el.append(draw(node.base));
      if (node.sup && node.sub) {
        el.append(h("span", { class: "mx-supsub" }, h("span", { class: "mx-sup" }, draw(node.sup)), h("span", { class: "mx-sub" }, draw(node.sub))));
      } else {
        if (node.sup) el.append(h("sup", { class: "mx-sup" }, draw(node.sup)));
        if (node.sub) el.append(h("sub", { class: "mx-sub" }, draw(node.sub)));
      }
      return el;
    }
    case "frac":
      return h("span", { class: "mx-frac" }, h("span", { class: "mx-num" }, draw(node.num)), h("span", { class: "mx-den" }, draw(node.den)));
    case "sqrt": {
      const el = h("span", { class: "mx-sqrt" });
      if (node.index) el.append(h("sup", { class: "mx-root" }, draw(node.index)));
      el.append(h("span", { class: "mx-radic", text: "√" }), h("span", { class: "mx-radicand" }, draw(node.body)));
      return el;
    }
    case "accent": {
      const flat = flatten(node.body);
      // A vector's arrow is drawn over it (the combining arrow is missing from
      // many fonts); one letter takes the other marks itself.
      if (node.mark === ACCENTS.vec) return h("span", { class: "mx-vecover" }, draw(node.body));
      if ([...flat].length === 1) return h("i", { class: "mx-var", text: flat + node.mark });
      return h("span", { class: "mx-over" }, draw(node.body));
    }
    case "over":
      return h("span", { class: node.under ? "mx-under" : "mx-over" }, draw(node.body));
    case "style": {
      const cls = node.style === "bold" ? "mx-bold" : node.style === "text" ? "mx-text" : "mx-rm";
      const inner = node.body.t === "sym" ? document.createTextNode(node.body.v) : draw(node.body);
      return h("span", { class: cls }, inner);
    }
    case "matrix": {
      const grid = h("span", { class: "mx-grid" });
      const cols = Math.max(1, ...node.rows.map((r) => r.length));
      grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
      for (const row of node.rows) {
        for (let k = 0; k < cols; k++) grid.append(h("span", { class: "mx-cell" }, row[k] ? draw(row[k]) : ""));
      }
      return h("span", { class: "mx-matrix" },
        node.open ? h("span", { class: "mx-delim", text: node.open }) : "",
        grid,
        node.close ? h("span", { class: "mx-delim", text: node.close }) : "",
      );
    }
  }
}

function drawAll(nodes: Node[], tag: "span" | "div"): HTMLElement {
  const el = h(tag);
  for (const n of nodes) el.append(draw(n));
  return el;
}

/** TeX as a math element: inline in the text, or a centred line of its own. */
export function renderMath(tex: string, display = false): HTMLElement {
  let nodes: Node[];
  try {
    nodes = new Parser(tex.trim()).parse();
  } catch {
    return h("span", { class: "md-code", text: tex });
  }
  const el = drawAll(nodes, display ? "div" : "span");
  el.className = display ? "mx mx-display" : "mx";
  return el;
}

/** For the tests: the text a formula reads as, without its layout. */
export function mathText(tex: string): string {
  return renderMath(tex).textContent ?? "";
}
