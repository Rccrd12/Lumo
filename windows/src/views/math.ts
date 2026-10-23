// TeX math in the chat's answers ($…$, $$…$$, \(…\), \[…\]), drawn as DOM
// with no library: the notation answers use — Greek letters, operators and
// arrows, sub- and superscripts, \frac, \sqrt, \vec (and \vect, \vv) and
// other accents, \mathbb and friends, \text, \left…\right with brackets as
// tall as what they hold, matrices, array, cases and aligned rows, sums with
// their limits above and below, and the physics package's \dd, \dv, \pdv,
// \abs, \norm and bra-kets. A command it does not know shows what it is
// given, or else its name, never raw markup.
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
  otimes: "⊗", odot: "⊙", ominus: "⊖", perp: "⊥", leqslant: "⩽", geqslant: "⩾", lesssim: "≲",
  gtrsim: "≳", nleq: "≰", ngeq: "≱", triangleq: "≜", doteq: "≐", coloneqq: "≔", asymp: "≍",
  models: "⊨", vdash: "⊢", dashv: "⊣", therefore: "∴", because: "∵", subsetneq: "⊊", supsetneq: "⊋",
  nsubseteq: "⊈", sqsubseteq: "⊑", sqcup: "⊔", sqcap: "⊓", uplus: "⊎", owns: "∋", complement: "∁",
  bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂", bigodot: "⨀", biguplus: "⨄", bigsqcup: "⨆",
  bigvee: "⋁", bigwedge: "⋀", diamond: "⋄", lozenge: "◊", blacksquare: "■", Box: "□", wp: "℘",
  imath: "ı", jmath: "ȷ", varkappa: "ϰ", digamma: "ϝ", colon: ":", cdotp: "·", ldotp: ".",
  backslash: "∖", lvert: "|", rvert: "|", lVert: "‖", rVert: "‖", lbrack: "[", rbrack: "]",
  sharp: "♯", flat: "♭", natural: "♮", bowtie: "⋈", amalg: "⨿", wr: "≀", oslash: "⊘", parallel: "∥", mid: "∣", nmid: "∤", top: "⊤", bot: "⊥",
  // Calculus and the rest
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬",
  iiint: "∭", oint: "∮", sqrt: "√", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", angle: "∠",
  degree: "°", prime: "′", dagger: "†", triangle: "△", square: "□", checkmark: "✓",
  // Arrows
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺", mapsto: "↦",
  longrightarrow: "⟶", longleftarrow: "⟵", uparrow: "↑", downarrow: "↓", nearrow: "↗", searrow: "↘",
  hookrightarrow: "↪", rightharpoonup: "⇀", Longrightarrow: "⟹", Longleftarrow: "⟸",
  Longleftrightarrow: "⟺", longleftrightarrow: "⟷", longmapsto: "⟼", Uparrow: "⇑", Downarrow: "⇓",
  updownarrow: "↕", nwarrow: "↖", swarrow: "↙", leadsto: "⇝", rightleftharpoons: "⇌",
  leftharpoonup: "↼", hookleftarrow: "↩", rightrightarrows: "⇉", circlearrowright: "↻",
  // Dots, brackets, spaces
  dots: "…", ldots: "…", dotsc: "…", dotsb: "⋯", dotsm: "⋯", dotsi: "⋯", dotso: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", langle: "⟨", rangle: "⟩",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}", vert: "|", Vert: "‖",
  "|": "‖", "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", _: "_",
  quad: " ", qquad: "  ", ",": " ", ":": " ", ";": " ", "!": "", " ": " ",
  enspace: " ", thinspace: " ", medspace: " ", thickspace: " ", ">": " ", negthinspace: "",
  // The number sets that notes define as macros of their own: \R, \N…
  R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ",
};

/** Functions set upright: \sin x, \lim, \max… */
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det", "dim",
  "ker", "deg", "gcd", "arg", "Pr", "mod", "rank", "tr", "sgn", "hom", "lcm", "Tr", "diag",
  "argmax", "argmin", "span", "Var", "Cov", "erf", "csch", "sech", "coth", "arccot",
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
  | { t: "style"; style: "bold" | "boldit" | "italic" | "upright" | "text"; body: Node }
  | { t: "matrix"; rows: Node[][]; open: string; close: string; align: string[]; kind: "matrix" | "aligned" | "cases" }
  | { t: "fence"; open: string; body: Node[]; close: string }
  | { t: "delim"; v: string }
  | { t: "big"; v: string; scale: number }
  | { t: "stack"; top: Node | null; body: Node; bottom: Node | null }
  | { t: "box"; body: Node }
  | { t: "op"; name: string };

/** What \left, \right, \middle and \big take: one character or one command. */
const DELIMS: Record<string, string> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", "/": "/", "<": "⟨", ">": "⟩",
  "\\{": "{", "\\}": "}", "\\|": "‖", "\\lbrace": "{", "\\rbrace": "}", "\\langle": "⟨", "\\rangle": "⟩",
  "\\vert": "|", "\\Vert": "‖", "\\lvert": "|", "\\rvert": "|", "\\lVert": "‖", "\\rVert": "‖",
  "\\lfloor": "⌊", "\\rfloor": "⌋", "\\lceil": "⌈", "\\rceil": "⌉", "\\lbrack": "[", "\\rbrack": "]",
  "\\backslash": "∖", "\\uparrow": "↑", "\\downarrow": "↓", "\\.": "", ".": "",
};

const BIG_SIZES: Record<string, number> = {
  big: 1.2, bigl: 1.2, bigr: 1.2, bigm: 1.2, Big: 1.6, Bigl: 1.6, Bigr: 1.6, Bigm: 1.6,
  bigg: 2, biggl: 2, biggr: 2, biggm: 2, Bigg: 2.4, Biggl: 2.4, Biggr: 2.4, Biggm: 2.4,
};

/** The environments: their brackets, how their columns line up, and their spacing. */
const ENVIRONMENTS: Record<string, { open: string; close: string; kind: "matrix" | "aligned" | "cases"; align?: string }> = {
  matrix: { open: "", close: "", kind: "matrix" },
  smallmatrix: { open: "", close: "", kind: "matrix" },
  array: { open: "", close: "", kind: "matrix" },
  subarray: { open: "", close: "", kind: "matrix" },
  pmatrix: { open: "(", close: ")", kind: "matrix" },
  bmatrix: { open: "[", close: "]", kind: "matrix" },
  Bmatrix: { open: "{", close: "}", kind: "matrix" },
  vmatrix: { open: "|", close: "|", kind: "matrix" },
  Vmatrix: { open: "‖", close: "‖", kind: "matrix" },
  cases: { open: "{", close: "", kind: "cases", align: "l" },
  dcases: { open: "{", close: "", kind: "cases", align: "l" },
  rcases: { open: "", close: "}", kind: "cases", align: "l" },
  aligned: { open: "", close: "", kind: "aligned", align: "rl" },
  align: { open: "", close: "", kind: "aligned", align: "rl" },
  alignat: { open: "", close: "", kind: "aligned", align: "rl" },
  alignedat: { open: "", close: "", kind: "aligned", align: "rl" },
  flalign: { open: "", close: "", kind: "aligned", align: "rl" },
  eqnarray: { open: "", close: "", kind: "aligned", align: "rcl" },
  split: { open: "", close: "", kind: "aligned", align: "rl" },
  gather: { open: "", close: "", kind: "aligned", align: "c" },
  gathered: { open: "", close: "", kind: "aligned", align: "c" },
  equation: { open: "", close: "", kind: "aligned", align: "c" },
  multline: { open: "", close: "", kind: "aligned", align: "c" },
};

/** Sums, products, limits…: in a formula on a line of its own, their scripts go above and below. */
const BIG_OPERATORS = new Set(["∑", "∏", "∐", "⋃", "⋂", "⨁", "⨂", "⨀", "⨄", "⨆", "⋁", "⋀"]);
const LIMIT_FUNCTIONS = new Set(["lim", "liminf", "limsup", "max", "min", "sup", "inf", "argmax", "argmin"]);

/** Where `\end{env}` closes the `\begin` whose body starts at `from`, nested ones skipped. */
function environmentEnd(s: string, from: number): { start: number; end: number } | null {
  const re = /\\(begin|end)\s*\{[^}]*\}/g;
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    depth += m[1] === "begin" ? 1 : -1;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/**
 * The body of an environment cut at its row breaks (`\\`) or its column marks
 * (`&`), but only those of this level: not inside braces nor a nested
 * environment, and never `\&`.
 */
function splitTop(body: string, at: "row" | "cell"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "\\") {
      if (body.startsWith("\\begin", i)) depth++;
      else if (body.startsWith("\\end", i)) depth--;
      if (body[i + 1] === "\\" && at === "row" && depth === 0) {
        parts.push(body.slice(from, i));
        i += 2;
        // \\[4pt]: the spacing is not drawn.
        const space = /^\s*\[[^\]]*\]/.exec(body.slice(i));
        if (space) i += space[0].length;
        from = i;
        i--;
        continue;
      }
      i++; // \& and \\ are not marks of this level
    } else if (c === "&" && at === "cell" && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(body.slice(from));
  return parts;
}

class Parser {
  private i = 0;
  private s: string;
  /** How many \left are open: only then does \right end what is being read. */
  private fences = 0;
  constructor(s: string) {
    this.s = s;
  }

  parse(): Node[] {
    const out: Node[] = [];
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "}") break;
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }
      if (this.fences > 0 && /^\\right(?![A-Za-z])/.test(this.s.slice(this.i, this.i + 7))) break;
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

  /** The whole formula: a "}" with no "{" is skipped, not the end of it. */
  parseAll(): Node[] {
    const out = this.parse();
    while (this.i < this.s.length) {
      this.i++;
      out.push(...this.parse());
    }
    return out;
  }

  private group(): Node {
    // At "{": up to its "}".
    this.i++;
    const fences = this.fences;
    this.fences = 0;
    const c = this.parse();
    this.fences = fences;
    if (this.s[this.i] === "}") this.i++;
    return { t: "group", c };
  }

  /** One argument: a group, a command, or one character. */
  private atom(): Node | null {
    const s = this.s;
    while (/\s/.test(s[this.i] ?? "")) this.i++;
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
    if (c === "&") return null;
    // The hyphen of the source is a minus sign in a formula.
    if (c === "-") return { t: "sym", v: "−", upright: true };
    return { t: "sym", v: c, upright: !/[A-Za-z]/.test(c) };
  }

  private name(): string {
    const s = this.s;
    this.i++; // the backslash
    const m = /^[A-Za-z]+/.exec(s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      // \operatorname*{argmax}: the star changes nothing drawn.
      if (s[this.i] === "*") this.i++;
      return m[0];
    }
    return s[this.i++] ?? "";
  }

  /** A delimiter after \left, \right, \middle or \big: "(" or "\langle", "." for none. */
  private delimiter(): string {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
    const s = this.s;
    if (s[this.i] === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(this.i));
      if (!m) return "";
      this.i += m[0].length;
      return DELIMS[m[0]] ?? SYMBOLS[m[1]] ?? "";
    }
    const c = s[this.i++] ?? "";
    return DELIMS[c] ?? c;
  }

  /** A braced argument read as words, unparsed: \color{red}, \hspace{1em}… */
  private raw(): string {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
    if (this.s[this.i] !== "{") return "";
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "{") depth++;
      else if (this.s[this.i] === "}" && --depth === 0) break;
    }
    const words = this.s.slice(start, this.i);
    this.i++;
    return words;
  }

  private command(): Node | null {
    const name = this.name();
    const arg = () => this.atom() ?? { t: "group" as const, c: [] };
    switch (name) {
      case "frac": case "dfrac": case "tfrac": case "cfrac":
        return { t: "frac", num: arg(), den: arg() };
      case "binom": case "dbinom": case "tbinom": {
        const top = arg();
        const bottom = arg();
        return { t: "matrix", rows: [[top], [bottom]], open: "(", close: ")", align: ["c"], kind: "matrix" };
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
      // \vect{v} and \vv{v}: the vector macros of many notes and packages.
      case "vect": case "vv": case "Vec": case "overrightarrow": return { t: "accent", mark: ACCENTS.vec, body: arg() };
      case "overleftarrow": return { t: "stack", top: { t: "sym", v: "←", upright: true }, body: arg(), bottom: null };
      case "overbrace": return { t: "stack", top: { t: "sym", v: "⏞", upright: true }, body: arg(), bottom: null };
      case "underbrace": return { t: "stack", top: null, body: arg(), bottom: { t: "sym", v: "⏟", upright: true } };
      case "overset": case "stackrel": {
        const top = arg();
        return { t: "stack", top, body: arg(), bottom: null };
      }
      case "underset": {
        const bottom = arg();
        return { t: "stack", top: null, body: arg(), bottom };
      }
      case "xrightarrow": case "xleftarrow": case "xRightarrow": case "xLeftarrow": case "xleftrightarrow": {
        const below = this.optional();
        const arrows: Record<string, string> = { xrightarrow: "⟶", xleftarrow: "⟵", xRightarrow: "⟹", xLeftarrow: "⟸", xleftrightarrow: "⟷" };
        return { t: "stack", top: arg(), body: { t: "sym", v: arrows[name], upright: true }, bottom: below };
      }
      case "boxed": case "fbox": return { t: "box", body: arg() };
      case "mathbb": case "Bbb": return this.mapped(arg(), doubleStruck);
      case "mathcal": case "mathscr": return this.mapped(arg(), script);
      case "mathfrak": return this.mapped(arg(), fraktur);
      case "mathbf": case "bf": case "vb": case "vectorbold": case "textbf":
        return name === "textbf" ? this.text("bold") : { t: "style", style: "bold", body: arg() };
      case "boldsymbol": case "bm": case "pmb":
        return { t: "style", style: "boldit", body: arg() };
      case "mathit": case "it": return { t: "style", style: "italic", body: arg() };
      case "mathrm": case "operatorname": case "mathsf": case "mathtt": case "rm": case "mathup":
        return { t: "style", style: "upright", body: arg() };
      case "text": case "textrm": case "textit": case "mbox": case "textnormal": case "textsf": case "texttt": case "hbox":
        return this.text("text");
      case "left": {
        const open = this.delimiter();
        this.fences++;
        const body = this.parse();
        this.fences--;
        let close = "";
        if (this.s.startsWith("\\right", this.i)) {
          this.i += "\\right".length;
          close = this.delimiter();
        }
        return { t: "fence", open, body, close };
      }
      case "right": {
        // A \right with no \left: its delimiter, as is.
        const d = this.delimiter();
        return d ? { t: "sym", v: d, upright: true } : null;
      }
      case "middle": return { t: "delim", v: this.delimiter() };
      case "begin": return this.environment();
      case "end": {
        arg();
        return null;
      }
      case "\\": case "newline": case "cr": {
        // A line break outside an environment: the rows are not drawn apart.
        const space = /^\s*\[[^\]]*\]/.exec(this.s.slice(this.i));
        if (space) this.i += space[0].length;
        return null;
      }
      case "displaystyle": case "textstyle": case "scriptstyle": case "scriptscriptstyle": case "limits":
      case "nolimits": case "notag": case "nonumber": case "hline": case "hdashline": case "nobreak":
      case "allowbreak": case "relax": case "strut": case "centering": case "small": case "large":
      case "Large": case "normalsize": case "footnotesize": case "tiny": case "huge": case "Huge":
        return null;
      case "label": case "hspace": case "vspace": case "phantom": case "vphantom": case "hphantom":
      case "kern": case "mkern": case "hskip": case "mskip":
        if (/^\s*\{/.test(this.s.slice(this.i))) this.raw();
        else this.dimension();
        return name === "hspace" || name === "phantom" || name === "hphantom" ? { t: "sym", v: " ", upright: true } : null;
      case "color": this.raw(); return null;
      case "textcolor": case "colorbox": this.raw(); return arg();
      case "tag": return { t: "style", style: "upright", body: { t: "sym", v: `  (${this.raw()})`, upright: true } };
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
    if (name in BIG_SIZES) {
      const v = this.delimiter();
      return v ? { t: "big", v, scale: BIG_SIZES[name] } : null;
    }
    if (ACCENTS[name]) return { t: "accent", mark: ACCENTS[name], body: arg() };
    if (FUNCTIONS.has(name)) return { t: "op", name };
    if (name in SYMBOLS) return { t: "sym", v: SYMBOLS[name], upright: true };
    // Unknown, as a macro of the answer's own (\vett{v}, \R…): what it is
    // given if it takes something, else its name, upright, rather than the markup.
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] === "{") return arg();
    return { t: "sym", v: name, upright: true };
  }

  /** A TeX length right here (\kern 2pt, \hskip-1mu), skipped. */
  private dimension() {
    const m = /^\s*-?[\d.]+\s*[a-z]{2}/.exec(this.s.slice(this.i));
    if (m) this.i += m[0].length;
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

  /** \text{…}: what is inside, as words; $…$ in it is math again. */
  private text(style: "text" | "bold"): Node {
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] !== "{") return { t: "group", c: [] };
    const words = this.raw();
    const parts: Node[] = words.split(/\$([^$]*)\$/).map((part, k) =>
      k % 2 ? { t: "group", c: new Parser(part).parseAll() } : { t: "sym", v: part.replace(/\\([{}$%&#_ ])/g, "$1"), upright: true },
    );
    const body: Node = parts.length === 1 ? parts[0] : { t: "group", c: parts };
    if (style === "bold") return { t: "style", style: "text", body: { t: "style", style: "bold", body } };
    return { t: "style", style: "text", body };
  }

  private mapped(node: Node, f: (c: string) => string): Node {
    const flat = flatten(node);
    return { t: "sym", v: [...flat].map(f).join(""), upright: true };
  }

  /** \begin{pmatrix} a & b \\ c & d \end{pmatrix}, cases, aligned, array… */
  private environment(): Node | null {
    const env = this.raw().trim();
    const base = env.replace(/\*$/, "");
    const spec = ENVIRONMENTS[base] ?? { open: "", close: "", kind: "matrix" as const };
    // What comes after the name: array's columns {c|c}, alignat's {2}, pmatrix*'s [r].
    let columns = spec.align ?? "";
    if (base === "array" || base === "subarray") columns = this.raw().replace(/[^lcr]/g, "");
    else if (base === "alignat" || base === "alignedat") this.raw();
    else if (env.endsWith("*") && this.s[this.i] === "[") {
      const end = this.s.indexOf("]", this.i);
      if (end > 0) {
        columns = this.s.slice(this.i + 1, end).replace(/[^lcr]/g, "");
        this.i = end + 1;
      }
    }
    const end = environmentEnd(this.s, this.i);
    const body = this.s.slice(this.i, end ? end.start : undefined);
    this.i = end ? end.end : this.s.length;
    const rows = splitTop(body, "row")
      .filter((r, k, all) => r.trim() !== "" || k < all.length - 1)
      .map((r) => splitTop(r, "cell").map((cell) => ({ t: "group" as const, c: new Parser(cell.trim()).parseAll() })));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const align: string[] = [];
    for (let k = 0; k < cols; k++) {
      if (spec.kind === "aligned" && columns === "rl") align.push(k % 2 ? "l" : "r");
      else align.push(columns[k] ?? columns[columns.length - 1] ?? "c");
    }
    return { t: "matrix", rows, open: spec.open, close: spec.close, align, kind: spec.kind };
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

/** Brackets drawn as lines that stretch to what they hold, in a 10×100 box. */
const DELIM_PATHS: Record<string, string> = {
  "(": "M8.5 1 C1 22 1 78 8.5 99",
  ")": "M1.5 1 C9 22 9 78 1.5 99",
  "[": "M8 1 H3 V99 H8",
  "]": "M2 1 H7 V99 H2",
  "{": "M8.5 1 C5 1 5 3 5 8 V42 C5 47 4 50 1.5 50 C4 50 5 53 5 58 V92 C5 97 5 99 8.5 99",
  "}": "M1.5 1 C5 1 5 3 5 8 V42 C5 47 6 50 8.5 50 C6 50 5 53 5 58 V92 C5 97 5 99 1.5 99",
  "|": "M5 0 V100",
  "‖": "M3 0 V100 M7 0 V100",
  "⟨": "M8 1 L2 50 L8 99",
  "⟩": "M2 1 L8 50 L2 99",
  "⌊": "M3 1 V99 H8",
  "⌋": "M7 1 V99 H2",
  "⌈": "M3 99 V1 H8",
  "⌉": "M7 99 V1 H2",
};

const SVG = "http://www.w3.org/2000/svg";

/** A bracket as tall as its row; its character stays in the text, for copying. */
function delimiter(v: string): HTMLElement | Text {
  const path = DELIM_PATHS[v];
  if (!path) return v ? h("span", { class: "mx-delim-text", text: v }) : document.createTextNode("");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(SVG, "path");
  line.setAttribute("d", path);
  svg.append(line);
  const wide = v === "{" || v === "}" ? " mx-delim-wide" : v === "|" || v === "‖" ? " mx-delim-thin" : "";
  return h("span", { class: `mx-delim${wide}` }, h("span", { class: "mx-delim-char", text: v }), svg);
}

/** Relations, with room on both sides: a = b, x ∈ A, f → g. */
const RELATIONS = new Set([..."=<>≤≥≠≈∼≃≅≡∝≪≫≺≻∈∉∋⊂⊃⊆⊇⊊⊋⊈⊑→←↔⇒⇐⇔⟹⟸⟺↦⟶⟵⟷⟼⇝⇌∥⊥≜≐≔≍⊨⊢⊣≲≳⩽⩾≰≱"]);
/** Operations between two terms, with a little less: a + b, a × b. A sign in front (−x) keeps none. */
const BINARY = new Set([..."+−×÷±∓·∗⋆∘∪∩∖∧∨⊕⊖⊗⊙⊘⊎⊔⊓"]);
const INTEGRALS = new Set([..."∫∬∭∮"]);

/** Set while drawing a formula on a line of its own: sums take their limits above and below. */
let displayMode = false;

function isBigOperator(node: Node | null): boolean {
  if (!node) return false;
  if (node.t === "sym") return BIG_OPERATORS.has(node.v);
  if (node.t === "op") return LIMIT_FUNCTIONS.has(node.name);
  if (node.t === "style") return node.style === "upright" && LIMIT_FUNCTIONS.has(flatten(node.body));
  return node.t === "stack";
}

function draw(node: Node): HTMLElement | Text {
  switch (node.t) {
    case "sym":
      return node.upright || node.v.length !== 1 ? document.createTextNode(node.v) : h("i", { class: "mx-var", text: node.v });
    case "op":
      return h("span", { class: "mx-op", text: node.name });
    case "group":
      return drawAll(node.c, "span");
    case "sup": {
      if (isBigOperator(node.base) && (displayMode || node.base?.t === "stack")) {
        // Limits above and below: ∑ with i=1 under it and n over it.
        const big = node.base?.t === "sym" ? " mx-bigop" : "";
        return h("span", { class: "mx-limits" },
          h("span", { class: "mx-limit" }, node.sup ? draw(node.sup) : ""),
          h("span", { class: `mx-limits-base${big}` }, node.base ? draw(node.base) : ""),
          h("span", { class: "mx-limit" }, node.sub ? draw(node.sub) : ""),
        );
      }
      const el = h("span", { class: "mx-script" });
      // ∫ in a formula of its own line: taller, its bounds beside it.
      if (displayMode && node.base?.t === "sym" && INTEGRALS.has(node.base.v)) el.append(h("span", { class: "mx-int", text: node.base.v }));
      else if (node.base) el.append(draw(node.base));
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
      const cls = { bold: "mx-bold", boldit: "mx-bold mx-boldit", italic: "mx-it", text: "mx-text", upright: "mx-rm" }[node.style];
      const inner = node.body.t === "sym" ? document.createTextNode(node.body.v) : draw(node.body);
      return h("span", { class: cls }, inner);
    }
    case "fence": {
      const inner = drawAll(node.body, "span");
      inner.className = "mx-fenced";
      return h("span", { class: "mx-fence" }, delimiter(node.open), inner, delimiter(node.close));
    }
    case "delim":
      return delimiter(node.v);
    case "big": {
      const el = h("span", { class: "mx-big", text: node.v });
      el.style.fontSize = `${node.scale}em`;
      return el;
    }
    case "stack":
      return h("span", { class: "mx-stack" },
        node.top ? h("span", { class: "mx-limit" }, draw(node.top)) : "",
        h("span", { class: "mx-stack-base" }, draw(node.body)),
        node.bottom ? h("span", { class: "mx-limit" }, draw(node.bottom)) : "",
      );
    case "box":
      return h("span", { class: "mx-box" }, draw(node.body));
    case "matrix": {
      const grid = h("span", { class: `mx-grid mx-grid-${node.kind}` });
      const cols = Math.max(1, ...node.rows.map((r) => r.length));
      grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
      for (const row of node.rows) {
        for (let k = 0; k < cols; k++) {
          const cell = h("span", { class: "mx-cell" }, row[k] ? draw(row[k]) : "");
          const align = node.align[k] ?? "c";
          if (align !== "c") cell.style.textAlign = align === "l" ? "left" : "right";
          // aligned: a gap between each pair of columns, none inside one.
          if (node.kind === "aligned" && k > 0 && k % 2 === 0) cell.classList.add("mx-cell-pair");
          grid.append(cell);
        }
      }
      if (!node.open && !node.close) return h("span", { class: "mx-matrix" }, grid);
      return h("span", { class: "mx-fence mx-matrix" }, delimiter(node.open), grid, delimiter(node.close));
    }
  }
}

function drawAll(nodes: Node[], tag: "span" | "div"): HTMLElement {
  const el = h(tag);
  let prev: Node | null = null;
  for (const n of nodes) {
    if (n.t === "sym" && n.upright && RELATIONS.has(n.v)) el.append(h("span", { class: "mx-rel", text: n.v }));
    else if (n.t === "sym" && n.upright && BINARY.has(n.v) && isOperand(prev)) el.append(h("span", { class: "mx-bin", text: n.v }));
    else el.append(draw(n));
    prev = n;
  }
  return el;
}

/** Whether a node ends a term, so that a + or − after it joins two terms. */
function isOperand(node: Node | null): boolean {
  if (!node) return false;
  if (node.t !== "sym") return node.t !== "delim";
  return !RELATIONS.has(node.v) && !BINARY.has(node.v) && !"([{⟨,;".includes(node.v) && node.v.trim() !== "";
}

/** TeX as a math element: inline in the text, or a centred line of its own. */
export function renderMath(tex: string, display = false): HTMLElement {
  let el: HTMLElement;
  try {
    const nodes = new Parser(tex.trim()).parseAll();
    displayMode = display;
    el = drawAll(nodes, display ? "div" : "span");
  } catch {
    return h("span", { class: "md-code", text: tex });
  } finally {
    displayMode = false;
  }
  el.className = display ? "mx mx-display" : "mx";
  return el;
}
